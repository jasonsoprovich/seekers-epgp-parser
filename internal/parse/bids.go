package parse

import (
	"regexp"
	"strings"
	"time"
)

var tellRe = regexp.MustCompile(`^(\S+) tells you, '(.*)'$`)

// A log owner's own outgoing chat always starts with "You " (say/tell/
// tells to guild/raid/party/etc.) followed by a quoted message — never
// another character's name, so this can't false-match someone else
// announcing a different item. See FindAnnouncementStart.
var ownChatRe = regexp.MustCompile(`^You .*, '(.*)'$`)

// How far apart two "send tells" announcements for the same item can be
// and still count as one bidding round (the opening call and a later
// "- last call" reminder — 2.5 minutes apart in the real sample) rather
// than two separate rounds (the same item name dropping again later in
// the raid). A reminder must NOT reset the window: bids already collected
// between the opening call and the reminder are still real bids.
const announcementSessionGap = 10 * time.Minute

// FindAnnouncementStart returns the timestamp of the EARLIEST line in the
// most recent unbroken run of "send tells" announcements for this item at
// or before cutoff — a "You ..., '<message>'" line whose message contains
// both "send tells" and the item name, case-insensitively. A "- last
// call" repeat within announcementSessionGap of the previous one extends
// the window backward to the opening call instead of restarting it; a gap
// larger than that starts a fresh run (a later, unrelated drop of the
// same item name). ok is false if no such line exists at all, meaning the
// officer hasn't said "send tells" for this item yet, or the item name
// doesn't match what they typed.
func FindAnnouncementStart(raw string, itemName string, cutoff time.Time) (foundAt time.Time, ok bool) {
	item := strings.ToLower(strings.TrimSpace(itemName))
	if item == "" {
		return time.Time{}, false
	}

	var times []time.Time
	for _, l := range splitLogLines(raw) {
		if l.Time.After(cutoff) {
			break
		}
		m := ownChatRe.FindStringSubmatch(l.Text)
		if m == nil {
			continue
		}
		msg := strings.ToLower(m[1])
		if strings.Contains(msg, "send tells") && strings.Contains(msg, item) {
			times = append(times, l.Time)
		}
	}
	if len(times) == 0 {
		return time.Time{}, false
	}

	start := times[len(times)-1]
	for i := len(times) - 2; i >= 0; i-- {
		if start.Sub(times[i]) > announcementSessionGap {
			break
		}
		start = times[i]
	}
	return start, true
}

// BidCandidate is one incoming tell that looked like a bid during a
// capture window. Item name isn't recorded here — the officer names the
// item once when they click Start, not per-tell — see CaptureBids.
type BidCandidate struct {
	CharacterName string
	OccurredAt    time.Time
	Tier          string
	Ambiguous     bool
	RawMessage    string
}

// CaptureBids scans raw log text for tells addressed to the log's owner
// between startAt and stopAt (inclusive) and extracts bid candidates.
//
// This is deliberately a manual Start/Stop window rather than an
// auto-detected "send tells" trigger: a real bid session (see
// bids_sample.txt) can have a *different* officer announcing a *different*
// item concurrently in the same raw chat — but /tell only reaches its
// recipient, so a given officer's own log only ever shows tells meant for
// them. One officer never has two bid collections active in their own log
// at once, which is exactly what makes a manual window safe and
// unambiguous instead of needing to disambiguate overlapping items.
func CaptureBids(raw string, startAt, stopAt time.Time) []BidCandidate {
	lines := splitLogLines(raw)

	var out []BidCandidate
	for _, l := range lines {
		if l.Time.Before(startAt) || l.Time.After(stopAt) {
			continue
		}
		m := tellRe.FindStringSubmatch(l.Text)
		if m == nil {
			continue
		}
		signal := DetectBidSignal(m[2])
		if signal.Tier == "" {
			continue
		}
		out = append(out, BidCandidate{
			CharacterName: m[1],
			OccurredAt:    l.Time,
			Tier:          signal.Tier,
			Ambiguous:     signal.Ambiguous,
			RawMessage:    m[2],
		})
	}
	return out
}

// ResolveLatestPerCharacter picks the last bid per character (by log
// order) as the default winner-eligible bid — a later tell from the same
// person means "changed my mind," matching how a live bid session
// actually works. Every candidate (including superseded ones) still comes
// from CaptureBids for the officer's review grid; this is just the
// starting default they can override before submitting.
func ResolveLatestPerCharacter(candidates []BidCandidate) map[string]BidCandidate {
	latest := make(map[string]BidCandidate, len(candidates))
	for _, c := range candidates {
		latest[strings.ToLower(c.CharacterName)] = c
	}
	return latest
}
