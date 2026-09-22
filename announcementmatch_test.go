package main

import (
	"testing"
	"time"

	"github.com/jasonsoprovich/seekers-epgp-parser/internal/config"
	"github.com/jasonsoprovich/seekers-epgp-parser/internal/parse"
)

// noKnownItems stands in for a.snapshotKnownItems in these tests — the
// site's known-item list plays no role in either scenario below.
func noKnownItems() []string { return nil }

// These are the two real lines from the 2026-09-21 Vex Thal live test
// (officer logs: "Denon's Drum.txt", "message.txt") that motivated the
// item-DB announcement-match mode. Phase 0's fix (dropping announceTriggerRe's
// \b anchors) already makes DetectAnnouncement find the glued-together
// Denon's line regardless of match mode; what only itemdb mode fixes is
// rejecting the unrelated buff request.
const (
	denonsLine = "[Mon Sep 21 20:26:51 2026] You say to your guild, 'Denon's Drums of Declivitysend tells'\n"
	ssSpLine   = "[Mon Sep 21 20:54:17 2026] You tell your raid, 'Send tells for SS/SP'\n"
)

func TestBuildAnnouncementMatcher_ItemDBRejectsBuffRequest(t *testing.T) {
	isItem := buildAnnouncementMatcher(config.AnnouncementMatchItemDB, noKnownItems)

	if item, _, ok := parse.DetectAnnouncement(ssSpLine, time.Time{}, time.Now(), isItem); ok {
		t.Errorf("itemdb mode detected a buff request as an announcement: %q", item)
	}

	item, _, ok := parse.DetectAnnouncement(denonsLine, time.Time{}, time.Now(), isItem)
	if !ok || item != "Denon's Drums of Declivity" {
		t.Errorf("itemdb mode: DetectAnnouncement(denonsLine) = (%q, %v), want (%q, true)", item, ok, "Denon's Drums of Declivity")
	}
}

func TestBuildAnnouncementMatcher_LegacyStillAcceptsBuffRequest(t *testing.T) {
	// Pins the fallback mode's known (accepted, not fixed) tradeoff: an
	// officer who switches to Legacy in Settings is back to the original
	// false-positive behavior for a short capitalized token. This is
	// intentional — see buildAnnouncementMatcher's doc comment.
	isItem := buildAnnouncementMatcher(config.AnnouncementMatchLegacy, noKnownItems)

	item, _, ok := parse.DetectAnnouncement(ssSpLine, time.Time{}, time.Now(), isItem)
	if !ok || item != "SS/SP" {
		t.Errorf("legacy mode: DetectAnnouncement(ssSpLine) = (%q, %v), want (%q, true)", item, ok, "SS/SP")
	}
}

func TestBuildAnnouncementMatcher_BothModesFindGluedDenons(t *testing.T) {
	for _, mode := range []string{config.AnnouncementMatchItemDB, config.AnnouncementMatchLegacy} {
		isItem := buildAnnouncementMatcher(mode, noKnownItems)
		item, _, ok := parse.DetectAnnouncement(denonsLine, time.Time{}, time.Now(), isItem)
		if !ok || item != "Denon's Drums of Declivity" {
			t.Errorf("mode %q: DetectAnnouncement(denonsLine) = (%q, %v), want (%q, true)", mode, item, ok, "Denon's Drums of Declivity")
		}
	}
}

func TestBuildAnnouncementMatcher_ItemDBAcceptsExactKnownFallback(t *testing.T) {
	// A real ledger name that (hypothetically) isn't in the embedded
	// index — all-lowercase here specifically so the structural check
	// (looksLikeItemName, which requires Capitalized words) would REJECT
	// it, proving this goes through the exact-name fallback
	// (parse.ExactKnownItem), not a reintroduced structural check.
	known := func() []string { return []string{"totally custom guild item"} }
	isItem := buildAnnouncementMatcher(config.AnnouncementMatchItemDB, known)

	raw := "[Mon Sep 21 20:00:00 2026] You say to your guild, 'totally custom guild item send tells'\n"
	if item, _, ok := parse.DetectAnnouncement(raw, time.Time{}, time.Now(), isItem); !ok || item != "totally custom guild item" {
		t.Errorf("DetectAnnouncement(known custom item) = (%q, %v), want (%q, true)", item, ok, "totally custom guild item")
	}
}

func TestBuildAnnouncementMatcher_ItemDBDoesNotReintroduceStructuralGuessing(t *testing.T) {
	// A made-up name that's neither a real Quarm item nor in the known
	// ledger list, but structurally passes looksLikeItemName (Capitalized
	// words, no punctuation): itemdb mode must reject it — its
	// exact-known-name fallback is not a backdoor to full structural
	// guessing — while legacy mode (predictably) still accepts it.
	const fakeButPlausible = "Glorbnak's Shimmering Pauldrons"
	raw := "[Mon Sep 21 20:00:00 2026] You say to your guild, '" + fakeButPlausible + " send tells'\n"

	itemdb := buildAnnouncementMatcher(config.AnnouncementMatchItemDB, noKnownItems)
	if item, _, ok := parse.DetectAnnouncement(raw, time.Time{}, time.Now(), itemdb); ok {
		t.Errorf("itemdb mode detected a made-up name as an announcement: %q", item)
	}

	legacy := buildAnnouncementMatcher(config.AnnouncementMatchLegacy, noKnownItems)
	if item, _, ok := parse.DetectAnnouncement(raw, time.Time{}, time.Now(), legacy); !ok || item != fakeButPlausible {
		t.Errorf("legacy mode: DetectAnnouncement(fake plausible name) = (%q, %v), want (%q, true)", item, ok, fakeButPlausible)
	}
}
