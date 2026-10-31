package parse

import (
	"regexp"
	"strings"
	"time"
)

// LootContext is what the officer's log says about where an item came from
// at the moment it was announced: the zone the officer was in and the NPCs
// slain shortly before. The app uses it to tell apart same-named items with
// different ids (internal/items.Resolve) — the log never carries the id.
type LootContext struct {
	Zone string
	// Most recent first, de-duplicated. Only kills since the last zone-in:
	// a kill in the previous zone can't be what's on this corpse.
	Killed []string
}

const (
	// A boss is usually looted and its items announced within minutes, but
	// a big raid can take a while to work through a corpse.
	lootKillWindow = 45 * time.Minute
	// The officer's clock and the log line's second can disagree slightly,
	// and the kill line can land a moment after an early announcement.
	lootKillSlack = 2 * time.Minute
	// How far back to look for the zone-in before giving up.
	lootZoneLookback = 18 * time.Hour
)

var (
	slainByRe = regexp.MustCompile(`^(.+?) has been slain by .+!$`)
	youSlewRe = regexp.MustCompile(`^You have slain (.+?)!$`)
)

// FindLootContext reads raw log text backwards from `at` and returns the
// zone and recent kills. It walks from the end of the string rather than
// splitting the whole log, so it stays cheap on a large file.
func FindLootContext(raw string, at time.Time) LootContext {
	out := LootContext{Killed: []string{}}
	seen := map[string]bool{}
	end := len(raw)
	for end > 0 {
		start := strings.LastIndexByte(raw[:end], '\n') + 1
		row := strings.TrimRight(raw[start:end], "\r")
		end = start - 1
		if row == "" {
			continue
		}
		m := logLineRe.FindStringSubmatch(row)
		if m == nil {
			continue
		}
		t, err := time.ParseInLocation(logTimeLayout, m[1], time.Local)
		if err != nil || t.After(at.Add(lootKillSlack)) {
			continue
		}
		if at.Sub(t) > lootZoneLookback {
			break
		}
		text := m[2]
		if z := zoneEnteredRe.FindStringSubmatch(text); z != nil && !notAZoneRe.MatchString(z[1]) {
			out.Zone = z[1]
			break
		}
		if at.Sub(t) > lootKillWindow {
			continue
		}
		var victim string
		if k := slainByRe.FindStringSubmatch(text); k != nil {
			victim = k[1]
		} else if k := youSlewRe.FindStringSubmatch(text); k != nil {
			victim = k[1]
		}
		if victim == "" || seen[strings.ToLower(victim)] {
			continue
		}
		seen[strings.ToLower(victim)] = true
		out.Killed = append(out.Killed, victim)
	}
	return out
}
