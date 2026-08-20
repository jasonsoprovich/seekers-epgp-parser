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

// FindAnnouncementStart returns the timestamp of the most recent line at
// or before cutoff where the log owner announced this item for bids — a
// "You ..., '<message>'" line whose message contains both "send tells"
// and the item name, case-insensitively (matches both the opening call
// and a later "- last call" repeat; the LAST one at/before cutoff wins,
// since that's the actual start of the final bidding window). ok is false
// if no such line exists, meaning the officer hasn't said "send tells"
// for this item yet, or the item name doesn't match what they typed.
func FindAnnouncementStart(raw string, itemName string, cutoff time.Time) (foundAt time.Time, ok bool) {
	item := strings.ToLower(strings.TrimSpace(itemName))
	if item == "" {
		return time.Time{}, false
	}
	for _, l := range splitLogLines(raw) {
		if l.Time.After(cutoff) {
			break
		}
		m := ownChatRe.FindStringSubmatch(l.Text)
		if m == nil {
			continue
		}
		msg := strings.ToLower(m[1])
		if !strings.Contains(msg, "send tells") || !strings.Contains(msg, item) {
			continue
		}
		foundAt, ok = l.Time, true
	}
	return foundAt, ok
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
