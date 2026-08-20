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
	lines := splitLogLines(raw)

	for i := 0; i < len(lines); i++ {
		if !whoStartRe.MatchString(lines[i].Text) {
			continue
		}
		if i+1 >= len(lines) || !whoDashRe.MatchString(lines[i+1].Text) {
			continue
		}

		blockStart := lines[i].Time
		var names []string
		closed := false
		var zone string
		var expected int

		j := i + 2
		for ; j < len(lines); j++ {
			if m := whoEndRe.FindStringSubmatch(lines[j].Text); m != nil {
				expected, _ = strconv.Atoi(m[1])
				zone = m[2]
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
