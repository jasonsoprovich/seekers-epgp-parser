// Package parse turns raw EverQuest client log text into structured
// attendance snapshots and loot-bid candidates. It never touches a file or
// the network — callers (the Wails app, or a future CLI/test) own reading
// the log and deciding what time range to look at.
package parse

import (
	"regexp"
	"strings"
	"time"
)

// EQ's client log timestamp is C's ctime()/asctime() format:
// "Www Mmm dd hh:mm:ss yyyy" — a single-digit day is space-padded ("Aug  9"),
// which Go's reference-time layout expresses with "_2" rather than "2".
const logTimeLayout = "Mon Jan _2 15:04:05 2006"

var logLineRe = regexp.MustCompile(`^\[([A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\] (.*)$`)

// LogLine is one timestamped line from the log, with the leading
// "[Www Mmm dd hh:mm:ss yyyy] " stripped off.
type LogLine struct {
	Time time.Time
	Text string
}

// splitLogLines parses every line of raw log text into LogLines, silently
// dropping lines that don't match the client's timestamp format (there
// shouldn't be any in a real log, but a copy-paste can lose a line's start).
func splitLogLines(raw string) []LogLine {
	rows := strings.Split(raw, "\n")
	lines := make([]LogLine, 0, len(rows))
	for _, row := range rows {
		row = strings.TrimRight(row, "\r")
		if row == "" {
			continue
		}
		m := logLineRe.FindStringSubmatch(row)
		if m == nil {
			continue
		}
		// ParseInLocation, not Parse: the log has no timezone of its own —
		// its wall-clock numbers ARE the officer's local time, since the EQ
		// client and this app run on the same machine. Parse() defaults to
		// UTC, which tags e.g. "10:19:48 PM" as 22:19:48 UTC; formatting
		// that to RFC3339 and displaying it back in the frontend's actual
		// local zone then shows the wrong wall-clock time (observed: a
		// 6-hour shift on a UTC-6 machine, log said 22:19:48, app showed
		// 4:19:48 PM instead of 10:19:48 PM).
		t, err := time.ParseInLocation(logTimeLayout, m[1], time.Local)
		if err != nil {
			continue
		}
		lines = append(lines, LogLine{Time: t, Text: m[2]})
	}
	return lines
}
