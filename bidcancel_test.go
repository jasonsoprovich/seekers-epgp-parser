package main

import (
	"testing"
	"time"

	"github.com/jasonsoprovich/seekers-epgp-parser/internal/parse"
)

// A "cancel my bid" tell must take the bidder off the live snapshot, not just
// be skipped itself — the site replaces the round from that list, so a
// cancelled bidder who is still in it stays on /live-bids (9/28 sim).
func TestCancelledBidders(t *testing.T) {
	t0 := time.Date(2026, 9, 28, 22, 0, 0, 0, time.UTC)
	at := func(s int) time.Time { return t0.Add(time.Duration(s) * time.Second) }
	bid := func(name string, s int) parse.BidCandidate {
		return parse.BidCandidate{CharacterName: name, Tier: "High Bid", OccurredAt: at(s)}
	}
	cancel := func(name string, s int) parse.BidCandidate {
		return parse.BidCandidate{CharacterName: name, Cancel: true, OccurredAt: at(s)}
	}

	candidates := []parse.BidCandidate{
		bid("Anna", 1), cancel("Anna", 5), // cancelled after bidding
		bid("Bob", 2), cancel("Bob", 2), // same-second cancel still counts
		cancel("Cyd", 1), bid("Cyd", 6), // cancelled first, then bid again: stands
		bid("Dee", 3),                   // never cancelled
		bid("Eve", 1), cancel("EVE", 4), // name case differs
		bid("Fay", 1), cancel("Fay", 3), bid("Fay", 8), // re-bid after cancelling
		cancel("Gus", 2), // cancel with no bid at all
	}

	bids, latestCancel := splitBidCancels(candidates)
	for _, b := range bids {
		if b.Cancel {
			t.Fatalf("splitBidCancels left a cancel tell in the bids: %+v", b)
		}
	}
	if len(bids) != 7 {
		t.Fatalf("got %d bids, want 7", len(bids))
	}

	got := cancelledBidders(bids, latestCancel)
	want := map[string]bool{"anna": true, "bob": true, "eve": true}
	for k := range want {
		if !got[k] {
			t.Errorf("%s should be cancelled", k)
		}
	}
	for _, k := range []string{"cyd", "dee", "fay", "gus"} {
		if got[k] {
			t.Errorf("%s should NOT be cancelled", k)
		}
	}
	if len(got) != len(want) {
		t.Errorf("cancelled set = %v, want exactly %v", got, want)
	}
}
