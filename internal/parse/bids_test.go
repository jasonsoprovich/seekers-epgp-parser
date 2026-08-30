package parse

import (
	_ "embed"
	"testing"
	"time"
)

//go:embed testdata/bids_sample.txt
var bidsSample string

func TestCaptureBids_RealSample(t *testing.T) {
	start := time.Date(2026, time.August, 17, 0, 0, 0, 0, time.Local)
	stop := time.Date(2026, time.August, 18, 0, 0, 0, 0, time.Local)

	candidates := CaptureBids(bidsSample, start, stop)

	// 22 "X tells you, '...'" lines total in the sample; 4 are unrelated
	// chatter ("zoom board meeting" — including a "10 minutes" duration
	// that must NOT read as a bid amount, see tier_test.go — "vacation
	// dates", "selos", "invite") with no real bid signal and must not show
	// up as candidates.
	if len(candidates) != 19 {
		names := make([]string, len(candidates))
		for i, c := range candidates {
			names[i] = c.CharacterName + ":" + c.Tier
		}
		t.Fatalf("got %d candidates, want 19: %v", len(candidates), names)
	}

	for _, c := range candidates {
		if c.Ambiguous {
			t.Errorf("%s's bid (%q) marked ambiguous unexpectedly", c.CharacterName, c.RawMessage)
		}
	}

	byName := map[string]BidCandidate{}
	for _, c := range candidates {
		byName[c.CharacterName] = c
	}

	wantHigh := []string{"Rizy", "Darkclaw", "Ieaini", "Disen", "Theofonias", "Hoder", "Takkisina", "Kaalos", "Leighi", "Astrael", "Xasik", "Bode", "Grimrose", "Koramak", "Grokenspiel", "Krayziefoo", "Allrin", "Stonae"}
	for _, name := range wantHigh {
		c, ok := byName[name]
		if !ok {
			t.Errorf("expected a bid from %s, found none", name)
			continue
		}
		if c.Tier != TierHigh {
			t.Errorf("%s: tier = %q, want %q (message: %q)", name, c.Tier, TierHigh, c.RawMessage)
		}
	}

	if c, ok := byName["Osui"]; !ok || c.Tier != TierLow {
		t.Errorf("Osui: expected %q, got %+v", TierLow, c)
	}

	for _, name := range []string{"Katrinka", "Tippy", "Tiliki"} {
		if _, ok := byName[name]; ok {
			t.Errorf("%s should not have been captured as a bid (off-topic tell)", name)
		}
	}
}

func TestCaptureBids_WindowExcludesOutsideTells(t *testing.T) {
	raw := "[Mon Aug 17 22:19:48 2026] Rizy tells you, 'high'\n" +
		"[Mon Aug 17 22:30:00 2026] Rizy tells you, 'low'\n"

	start := time.Date(2026, time.August, 17, 22, 19, 0, 0, time.Local)
	stop := time.Date(2026, time.August, 17, 22, 20, 0, 0, time.Local)

	candidates := CaptureBids(raw, start, stop)
	if len(candidates) != 1 {
		t.Fatalf("got %d candidates, want 1 (window should exclude the 22:30 tell)", len(candidates))
	}
	if candidates[0].Tier != TierHigh {
		t.Errorf("tier = %q, want %q", candidates[0].Tier, TierHigh)
	}
}

func TestFindAnnouncementStart_RealSample(t *testing.T) {
	// Cutoff after the "- last call" repeat (22:22:18) but before the
	// grats/close line (22:23:18). The two announcements are 2m34s apart
	// (well under announcementSessionGap), so the reminder must NOT reset
	// the window — it should resolve to the OPENING call (22:19:44), or
	// every bid placed before the reminder (18 of 19 in this sample) would
	// be silently excluded.
	cutoff := time.Date(2026, time.August, 17, 22, 23, 0, 0, time.Local)
	found, ok := FindAnnouncementStart(bidsSample, "Soul Essence of Aten Ha Ra", cutoff)
	if !ok {
		t.Fatal("expected an announcement to be found")
	}
	want := time.Date(2026, time.August, 17, 22, 19, 44, 0, time.Local)
	if !found.Equal(want) {
		t.Errorf("found = %v, want %v (the opening call, not the last-call reminder)", found, want)
	}
}

func TestFindAnnouncementStart_DistantReannouncementStartsFreshWindow(t *testing.T) {
	raw := "[Mon Aug 17 20:00:00 2026] You say to your guild, 'Ring of the Ancients send tells'\n" +
		"[Mon Aug 17 20:01:00 2026] Rizy tells you, 'high'\n" +
		"[Mon Aug 17 22:30:00 2026] You say to your guild, 'Ring of the Ancients send tells'\n" +
		"[Mon Aug 17 22:31:00 2026] Darkclaw tells you, 'high'\n"

	cutoff := time.Date(2026, time.August, 17, 22, 32, 0, 0, time.Local)
	found, ok := FindAnnouncementStart(raw, "Ring of the Ancients", cutoff)
	if !ok {
		t.Fatal("expected an announcement to be found")
	}
	want := time.Date(2026, time.August, 17, 22, 30, 0, 0, time.Local)
	if !found.Equal(want) {
		t.Errorf("found = %v, want %v (the second drop's own call, 2.5 hours after the first — must not merge with it)", found, want)
	}
}

func TestFindAnnouncementStart_IgnoresOtherOfficersAndOtherItems(t *testing.T) {
	cutoff := time.Date(2026, time.August, 17, 22, 21, 0, 0, time.Local)
	// Only "Armguard of Shadows" send-tells lines exist at/before this
	// cutoff (from Mendacious, not "You") — none should match a search
	// for a different item.
	if _, ok := FindAnnouncementStart(bidsSample, "Torch of Judgment", cutoff); ok {
		t.Error("expected no match for an item nobody has announced yet")
	}
}

func TestFindAnnouncementStart_NoMatchReturnsFalse(t *testing.T) {
	if _, ok := FindAnnouncementStart(bidsSample, "Something Nobody Announced", time.Now()); ok {
		t.Error("expected ok=false for an item never announced")
	}
}

func TestResolveLatestPerCharacter_LastBidWins(t *testing.T) {
	t1 := time.Date(2026, time.August, 17, 22, 19, 0, 0, time.Local)
	t2 := t1.Add(time.Minute)
	candidates := []BidCandidate{
		{CharacterName: "Rizy", OccurredAt: t1, Tier: TierHigh, RawMessage: "high"},
		{CharacterName: "Rizy", OccurredAt: t2, Tier: TierLow, RawMessage: "actually low"},
	}

	latest := ResolveLatestPerCharacter(candidates)
	got, ok := latest["rizy"]
	if !ok {
		t.Fatal("expected an entry for rizy")
	}
	if got.Tier != TierLow {
		t.Errorf("latest tier = %q, want %q (the revised bid)", got.Tier, TierLow)
	}
}

func TestExtractItemName(t *testing.T) {
	cases := []struct{ msg, want string }{
		{"Soul Essence of Aten Ha Ra send tells", "Soul Essence of Aten Ha Ra"},
		{"send tells for Soul Essence of Aten Ha Ra", "Soul Essence of Aten Ha Ra"},
		{"Soul Essence of Aten Ha Ra - send tells now", "Soul Essence of Aten Ha Ra"},
		{"Soul Essence of Aten Ha Ra send tells - last call", "Soul Essence of Aten Ha Ra"},
		{"Send Tells  Robe of the Kedge", "Robe of the Kedge"},
		{"Blade of the Black Dragon Eye send tells please", "Blade of the Black Dragon Eye"},
		{"send tells: Torch of Judgment", "Torch of Judgment"},
		{"item Cloak of Flames send tells", "Cloak of Flames"},
		{"no trigger phrase here", "no trigger phrase here"}, // caller checks for "send tells" separately
	}
	for _, c := range cases {
		if got := extractItemName(c.msg); got != c.want {
			t.Errorf("extractItemName(%q) = %q, want %q", c.msg, got, c.want)
		}
	}
}

func TestDetectAnnouncement_RealSample(t *testing.T) {
	before := time.Date(2026, time.August, 17, 22, 0, 0, 0, time.Local)
	after := time.Date(2026, time.August, 17, 23, 0, 0, 0, time.Local)

	// The newest of the log owner's own "send tells" lines wins (there are
	// two — the opening call and the "- last call" repeat).
	item, at, ok := DetectAnnouncement(bidsSample, before, after)
	if !ok {
		t.Fatal("expected to detect the officer's own announcement")
	}
	if item != "Soul Essence of Aten Ha Ra" {
		t.Errorf("item = %q, want %q", item, "Soul Essence of Aten Ha Ra")
	}
	wantAt := time.Date(2026, time.August, 17, 22, 22, 18, 0, time.Local)
	if !at.Equal(wantAt) {
		t.Errorf("at = %v, want %v (the '- last call' line, newest)", at, wantAt)
	}

	// Other officers announcing other items in the same channel
	// ("Mendacious tells the guild, 'Armguard of Shadows send tells'") must
	// never trigger — only the log owner's own outgoing chat counts.
	if item == "Armguard of Shadows" || item == "Torch of Judgment" {
		t.Errorf("picked up another officer's announcement: %q", item)
	}

	// Nothing new after the last own announcement.
	if _, _, ok := DetectAnnouncement(bidsSample, wantAt, after); ok {
		t.Error("expected no detection after the last own announcement")
	}
}
