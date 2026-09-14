package parse

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// EQ logs a /random as two adjacent lines, same timestamp:
//
//	**A Magic Die is rolled by Tabbie.
//	**It could have been any number from 0 to 222, but this time it turned up a 69.
var (
	reRollAnnounce = regexp.MustCompile(`^\*\*A Magic Die is rolled by (.+?)\.$`)
	reRollResult   = regexp.MustCompile(`^\*\*It could have been any number from (\d+) to (\d+), but this time it turned up a (\d+)\.$`)
)

// pendingRollTTL bounds how long an announce line may wait for its result
// line before the result is treated as orphaned and dropped (a truncated
// or rotated log) — same 2s window pq-companion's rolltracker.Tracker
// uses. A second announce before the first's result arrives silently
// overwrites the pending slot rather than queueing — accepted, not fixed,
// upstream too: the EQ client logs both lines of one roll back-to-back
// with an identical timestamp, and this parser reads strictly in log
// order, so two players' announces landing in exactly the same second
// essentially never happens in practice.
const pendingRollTTL = 2 * time.Second

// RollEvent is one completed /random result, correlated from its
// announce+result line pair.
type RollEvent struct {
	Roller     string
	Min        int
	Max        int
	Value      int
	OccurredAt time.Time
}

// ParseRollEvents scans raw log text for every completed /random and
// returns them in log order.
func ParseRollEvents(raw string) []RollEvent {
	var pendingRoller string
	var pendingAt time.Time

	var out []RollEvent
	for _, l := range splitLogLines(raw) {
		if m := reRollAnnounce.FindStringSubmatch(l.Text); m != nil {
			pendingRoller = m[1]
			pendingAt = l.Time
			continue
		}
		m := reRollResult.FindStringSubmatch(l.Text)
		if m == nil {
			continue
		}
		roller, at := pendingRoller, pendingAt
		pendingRoller = ""
		if roller == "" || l.Time.Sub(at) > pendingRollTTL {
			continue // orphaned result — no matching announce nearby
		}
		min, err1 := strconv.Atoi(m[1])
		max, err2 := strconv.Atoi(m[2])
		value, err3 := strconv.Atoi(m[3])
		if err1 != nil || err2 != nil || err3 != nil {
			continue
		}
		out = append(out, RollEvent{Roller: roller, Min: min, Max: max, Value: value, OccurredAt: l.Time})
	}
	return out
}

// Roll is one player's completed /random within a RollSession.
type Roll struct {
	Roller     string
	Value      int
	OccurredAt time.Time
	// Duplicate is true for every roll after a player's FIRST one in this
	// session — kept visible (struck-through in the UI) but never
	// eligible to win. A re-roll means "I already had my shot," same rule
	// pq-companion uses.
	Duplicate bool
}

// RollSession is every roll seen for one (Min,Max) range within one
// unbroken run of rolling — see BucketRollEvents.
type RollSession struct {
	ID         string
	Min        int
	Max        int
	StartedAt  time.Time
	LastRollAt time.Time
	Rolls      []Roll
}

// RangeKey identifies a roll range for the officer-app's own boundary
// bookkeeping (app.go) — exported so it can key the same map the bucketer
// reads.
func RangeKey(min, max int) string {
	return fmt.Sprintf("%d-%d", min, max)
}

func sessionID(min, max int, startedAt time.Time) string {
	return fmt.Sprintf("%d-%d-%d", min, max, startedAt.UnixNano())
}

// staleRollGap is how long a (Min,Max) range can go with no new roll
// before the next one starts a brand-new session instead of joining the
// old one — an abandoned roll-off picked back up later in the raid is a
// new one, not a continuation.
const staleRollGap = 5 * time.Minute

// BucketRollEvents groups a flat, chronological event list into sessions
// per exact (Min,Max) pair — a "/random 100" and a "/random 22 100" never
// merge even though Max matches, since a non-zero floor changes the odds.
// Within one range, consecutive rolls join the same session unless:
//
//   - more than staleRollGap has passed since that range's last roll, or
//   - a manual boundary (boundaries[RangeKey(min,max)], set by app.go when
//     the officer Stops or Removes a session) falls strictly between the
//     two rolls — forcing a new session even if the gap is short, so a
//     re-roll for the same range moments after the officer ended a round
//     doesn't silently reopen the round they just finished.
//
// Only events strictly after clearedBefore are considered — the officer's
// "Clear all" action.
func BucketRollEvents(events []RollEvent, boundaries map[string]time.Time, clearedBefore time.Time) []RollSession {
	byRange := make(map[string][]RollEvent)
	var order []string
	for _, e := range events {
		if !e.OccurredAt.After(clearedBefore) {
			continue
		}
		k := RangeKey(e.Min, e.Max)
		if _, ok := byRange[k]; !ok {
			order = append(order, k)
		}
		byRange[k] = append(byRange[k], e)
	}

	var sessions []RollSession
	for _, k := range order {
		boundary := boundaries[k] // zero value if none set

		var cur *RollSession
		seen := map[string]bool{}
		for _, e := range byRange[k] {
			newSession := cur == nil ||
				e.OccurredAt.Sub(cur.LastRollAt) > staleRollGap ||
				(!boundary.IsZero() && !cur.LastRollAt.After(boundary) && e.OccurredAt.After(boundary))
			if newSession {
				if cur != nil {
					sessions = append(sessions, *cur)
				}
				cur = &RollSession{Min: e.Min, Max: e.Max, StartedAt: e.OccurredAt, ID: sessionID(e.Min, e.Max, e.OccurredAt)}
				seen = map[string]bool{}
			}
			roller := strings.ToLower(e.Roller)
			dup := seen[roller]
			seen[roller] = true
			cur.Rolls = append(cur.Rolls, Roll{Roller: e.Roller, Value: e.Value, OccurredAt: e.OccurredAt, Duplicate: dup})
			cur.LastRollAt = e.OccurredAt
		}
		if cur != nil {
			sessions = append(sessions, *cur)
		}
	}

	sort.Slice(sessions, func(i, j int) bool { return sessions[i].StartedAt.Before(sessions[j].StartedAt) })
	return sessions
}

// WinnersOf returns the roller name(s) tied for best among each player's
// FIRST (non-duplicate) roll — ties are legitimate and all returned, with
// no secondary tiebreak, matching pq-companion.
func WinnersOf(rolls []Roll, highest bool) []string {
	type entry struct {
		name  string
		value int
	}
	var firsts []entry
	seen := map[string]bool{}
	for _, r := range rolls {
		if r.Duplicate {
			continue
		}
		key := strings.ToLower(r.Roller)
		if seen[key] {
			continue
		}
		seen[key] = true
		firsts = append(firsts, entry{name: r.Roller, value: r.Value})
	}
	if len(firsts) == 0 {
		return nil
	}
	target := firsts[0].value
	for _, e := range firsts[1:] {
		if highest && e.value > target {
			target = e.value
		}
		if !highest && e.value < target {
			target = e.value
		}
	}
	var winners []string
	for _, e := range firsts {
		if e.value == target {
			winners = append(winners, e.name)
		}
	}
	return winners
}
