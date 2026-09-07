package parse

import (
	"fmt"
	"regexp"
	"strconv"
	"time"
)

var (
	whoStartRe = regexp.MustCompile(`^Players on EverQuest:$`)
	whoDashRe  = regexp.MustCompile(`^-+$`)
	// Matches both a normal row ("[60 Warlock] Kuky (Unknown) <Seekers of
	// Souls>") and an anonymous row ("[ANONYMOUS] Hawthor  <Seekers of
	// Souls>") — the character name is always the first token right after
	// the closing bracket in either shape, so one pattern covers both
	// without needing level/class/race, which attendance doesn't use.
	whoRowRe = regexp.MustCompile(`^\[(?:\d+ [^\]]+|ANONYMOUS)\]\s+(\S+)`)
	// Closes a /who block. "There is 1 player in EverQuest." (a name lookup
	// that found one person) is just as much a closing line as "There are N
	// players…" — the old `are`-only pattern left every single-result /who
	// the officer ever ran looking Unclosed, spraying hundreds of warnings
	// across a months-old log.
	whoEndRe = regexp.MustCompile(`^There (?:is|are) (\d+) players? in (.+)\.$`)
	// "There are no players in EverQuest." — an empty /who result. Ends the
	// block with zero names; not an error, just nobody matched.
	whoEmptyRe = regexp.MustCompile(`^There (?:is|are) no (?:players?|one) `)

	// The client prints this every time you zone in. It's the only
	// reliable "where is the officer standing" signal — `/who guild` (which
	// officers use to also catch anonymous raiders) closes with "There are
	// N players in EverQuest." / "...in all zones.", not the raid zone, so
	// the /who footer alone can't be trusted for the zone. We track the
	// most recent real zone-in before each /who block and prefer it.
	zoneEnteredRe = regexp.MustCompile(`^You have entered (.+)\.$`)
	// "You have entered an area where levitation effects do not function."
	// and friends match zoneEnteredRe but aren't zones.
	notAZoneRe = regexp.MustCompile(`(?i)^an area\b`)
)

// AttendanceSnapshot is one "/who guild" capture — a raid-tick roster read
// straight off the log, character names only (level/class/race are a
// character-profile concern handled elsewhere in the app, not attendance).
type AttendanceSnapshot struct {
	OccurredAt time.Time
	Zone       string
	Names      []string
	// ExpectedCount is the log's own "There are N players in <Zone>" count
	// — compare against len(Names) as an integrity check; see Warnings. 0
	// when the block had no closing line (Unclosed).
	ExpectedCount int
	// Unclosed is true when the block's roster lines were read but no
	// "There are N players" footer followed (some client builds / a
	// truncated `/who`, or a stray line ending the block early). The names
	// are still returned — the officer verifies the list — but a caller
	// choosing "the latest capture" should prefer a closed one.
	Unclosed bool
}

// ParseAttendance finds every "/who guild" block in raw log text.
// Warnings are non-fatal: a block whose parsed name count doesn't match
// the log's own "There are N players" line still comes back in snapshots,
// just flagged, so the officer can decide whether to trust it rather than
// having it silently dropped or silently accepted.
func ParseAttendance(raw string) (snapshots []AttendanceSnapshot, warnings []string) {
	// Both start non-nil (not just declared) so a clean run — the common
	// case — serializes to JSON "[]", not "null". The frontend calls
	// .map() on both without a nil guard (main.AttendanceResult's fields
	// are typed as plain arrays, not optional), so a nil slice here
	// crashes the Attendance tab on every ordinary, warning-free capture.
	warnings = []string{}
	lines := splitLogLines(raw)

	// The zone the officer is standing in, from the most recent "You have
	// entered X." seen so far. Linear scan, so at any /who block this holds
	// the last zone-in before it. Empty until the first zone-in in the
	// captured range (or if the paste starts mid-zone) — then we fall back
	// to the /who footer.
	currentZone := ""

	for i := 0; i < len(lines); i++ {
		if m := zoneEnteredRe.FindStringSubmatch(lines[i].Text); m != nil && !notAZoneRe.MatchString(m[1]) {
			currentZone = m[1]
			continue
		}
		if !whoStartRe.MatchString(lines[i].Text) {
			continue
		}
		if i+1 >= len(lines) || !whoDashRe.MatchString(lines[i+1].Text) {
			continue
		}

		blockStart := lines[i].Time
		names := []string{}
		closed := false
		var footerZone string
		var expected int

		// Read roster lines until the "There are N players" footer. A `/who`
		// prints within a second or two even for a big guild, but on a busy
		// raid pull the client interleaves combat / spell / chat lines
		// between the roster rows — those are skipped, not treated as the
		// end of the block. The scan stops only at the footer, the next
		// `/who`, a line well past the print window (`whoBlockWindow` — the
		// `/who` is clearly over), or a hard line cap. (This replaces a
		// raw "8 stray lines and we bail" cap that intermittently dropped
		// the tail of a `/who` split across frames — the "sometimes 18,
		// sometimes 20" under-count.)
		const whoBlockWindow = 45 * time.Second
		const whoBlockLineCap = 5000
		empty := false
		j := i + 2
		scanned := 0
		for ; j < len(lines) && scanned < whoBlockLineCap; j, scanned = j+1, scanned+1 {
			if m := whoEndRe.FindStringSubmatch(lines[j].Text); m != nil {
				expected, _ = strconv.Atoi(m[1])
				footerZone = m[2]
				closed = true
				break
			}
			if whoEmptyRe.MatchString(lines[j].Text) {
				empty = true
				closed = true
				break
			}
			if m := whoRowRe.FindStringSubmatch(lines[j].Text); m != nil {
				names = append(names, m[1])
				continue
			}
			if whoDashRe.MatchString(lines[j].Text) {
				continue // a second rule line, harmless
			}
			if whoStartRe.MatchString(lines[j].Text) {
				j-- // let the outer loop pick this up as the next block
				break
			}
			// An unrelated line whose timestamp is well past the block start
			// (a real event after the /who finished). A zero/unparseable
			// timestamp yields a large negative delta — treat that as "still
			// in the block", i.e. just skip the line.
			if !lines[j].Time.IsZero() && lines[j].Time.Sub(blockStart) > whoBlockWindow {
				break
			}
		}

		if len(names) == 0 {
			// A `/who` that matched nobody ("There are no players…") is
			// routine, not a problem — skip it silently. Only warn when a
			// block had a roster we couldn't read (a real parse failure).
			if !empty {
				warnings = append(warnings, fmt.Sprintf(
					"attendance block starting %s had no readable roster lines — skipped",
					blockStart.Format(time.RFC3339)))
			}
			i = j
			continue
		}

		// Prefer the zone the officer actually zoned into; the /who footer
		// is the fallback (accurate for a plain `/who`, generic for
		// `/who guild`).
		zone := currentZone
		if zone == "" {
			zone = footerZone
		}

		if !closed {
			// Some client builds don't print the footer on `/who guild`, or
			// the `/who` was truncated. The names are still usable — the
			// officer reviews the list before submitting — so emit the
			// snapshot flagged rather than dropping the whole capture. The
			// caller prefers a closed snapshot when one exists.
			warnings = append(warnings, fmt.Sprintf(
				"attendance block at %s: no closing \"There are N players\" line — parsed %d name(s); double-check the list",
				blockStart.Format(time.RFC3339), len(names)))
		} else if expected != len(names) {
			// A 1-3 gap is almost always someone zoning right as the /who
			// printed (the footer count and the roster snapshot are a moment
			// apart) — a nudge, not an alarm. A big gap means rows really
			// were missed or a paste got cut.
			gap := expected - len(names)
			if gap < 0 {
				gap = -gap
			}
			how := "usually someone zoning as the /who printed — verify the list below"
			if gap > 3 {
				how = "rows were missed, or a paste got cut off — check the list carefully"
			}
			warnings = append(warnings, fmt.Sprintf(
				"attendance block at %s (%s): read %d name(s), the /who footer says %d — %s",
				blockStart.Format(time.RFC3339), zone, len(names), expected, how))
		}

		snapshots = append(snapshots, AttendanceSnapshot{
			OccurredAt:    blockStart,
			Zone:          zone,
			Names:         names,
			ExpectedCount: expected,
			Unclosed:      !closed,
		})
		i = j
	}

	return snapshots, warnings
}
