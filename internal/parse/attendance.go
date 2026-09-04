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
	whoEndRe = regexp.MustCompile(`^There are (\d+) players? in (.+)\.$`)

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
	// — compare against len(Names) as an integrity check; see Warnings.
	ExpectedCount int
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

		j := i + 2
		for ; j < len(lines); j++ {
			if m := whoEndRe.FindStringSubmatch(lines[j].Text); m != nil {
				expected, _ = strconv.Atoi(m[1])
				footerZone = m[2]
				closed = true
				break
			}
			m := whoRowRe.FindStringSubmatch(lines[j].Text)
			if m == nil {
				// Something else interrupted the block (chat, combat spam)
				// before it closed — stop reading this block rather than
				// guessing where it actually ends.
				break
			}
			names = append(names, m[1])
		}

		if !closed {
			warnings = append(warnings, fmt.Sprintf(
				"attendance block starting %s never closed with a \"There are N players\" line — skipped",
				blockStart.Format(time.RFC3339)))
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

		if expected != len(names) {
			warnings = append(warnings, fmt.Sprintf(
				"attendance block at %s (%s): parsed %d name(s) but the log reports %d players — check for a cut-off paste",
				blockStart.Format(time.RFC3339), zone, len(names), expected))
		}

		snapshots = append(snapshots, AttendanceSnapshot{
			OccurredAt:    blockStart,
			Zone:          zone,
			Names:         names,
			ExpectedCount: expected,
		})
		i = j
	}

	return snapshots, warnings
}
