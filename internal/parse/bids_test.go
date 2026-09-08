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
		// "last call" and friends, in the shapes officers actually type
		{"Cloak of Flames send tells last call", "Cloak of Flames"},
		{"Cloak of Flames send tells FINAL CALL", "Cloak of Flames"},
		{"Cloak of Flames send tells - last calls", "Cloak of Flames"},
		{"send tells Cloak of Flames last call please", "Cloak of Flames"},
		{"Cloak of Flames send tells lc", "Cloak of Flames"},
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
	item, at, ok := DetectAnnouncement(bidsSample, before, after, nil)
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
	if _, _, ok := DetectAnnouncement(bidsSample, wantAt, after, nil); ok {
		t.Error("expected no detection after the last own announcement")
	}
}

// --- post-live-test-1: trigger grammar + item validation (LT-03 / LT-04) ---

func TestLooksLikeItemName(t *testing.T) {
	ok := []string{
		"Cloak of Flames", "Soul Essence of Aten Ha Ra", "Robe of the Kedge Knight",
		"Journeyman's Boots", "Mask of Piety", "Type 3 Armor Pattern",
	}
	for _, s := range ok {
		if !looksLikeItemName(s) {
			t.Errorf("looksLikeItemName(%q) = false, want true", s)
		}
	}
	bad := []string{
		"last call it reset the bids on mine cause it saw send",
		"last call, send tells", "final call on this one guys",
		"send tells now please", "ok that's it for tonight", "",
	}
	for _, s := range bad {
		if looksLikeItemName(s) {
			t.Errorf("looksLikeItemName(%q) = true, want false", s)
		}
	}
}

func TestDetectAnnouncement_RejectsProseTrigger(t *testing.T) {
	// The first live test's actual failure: "send tells" typed inside a
	// sentence. Must NOT be detected as an announcement (it was auto-starting
	// a junk round named after the prose and wiping the live one).
	raw := "[Mon Aug 17 20:00:00 2026] You say to your guild, 'last call, it reset the bids on mine cause it saw send tells'\n"
	if item, _, ok := DetectAnnouncement(raw, time.Time{}, time.Now(), nil); ok {
		t.Errorf("detected a prose line as an announcement: %q", item)
	}
}

func TestDetectAnnouncement_StartBidsTrigger(t *testing.T) {
	raw := "[Mon Aug 17 20:00:00 2026] You say to your guild, 'Mask of Piety start bids'\n"
	item, _, ok := DetectAnnouncement(raw, time.Time{}, time.Now(), nil)
	if !ok || item != "Mask of Piety" {
		t.Errorf("DetectAnnouncement = (%q, %v), want (%q, true)", item, ok, "Mask of Piety")
	}
}

func TestDetectAnnouncement_KnownItemAcceptsLowercase(t *testing.T) {
	// A brand-new-looking lowercase name wouldn't pass the structural check,
	// but an exact match against the site's item list rescues it.
	raw := "[Mon Aug 17 20:00:00 2026] You say to your guild, 'cloak of flames send tells'\n"
	if _, _, ok := DetectAnnouncement(raw, time.Time{}, time.Now(), nil); ok {
		t.Fatal("expected lowercase prose-ish name to be rejected without a known-items hit")
	}
	item, _, ok := DetectAnnouncement(raw, time.Time{}, time.Now(), []string{"Cloak of Flames"})
	if !ok || item != "cloak of flames" {
		t.Errorf("with known items: DetectAnnouncement = (%q, %v), want (%q, true)", item, ok, "cloak of flames")
	}
}

func TestDetectAnnouncement_ItemLink(t *testing.T) {
	// Officer pastes the clickable item link into the call. stripItemLinks
	// pulls the visible name back out of the 0x12-delimited markup.
	raw := "[Mon Aug 17 20:00:00 2026] You say to your guild, '\x12000042000000000000000000000000000000000000000000000000Cloak of Flames\x12 send tells last call'\n"
	item, _, ok := DetectAnnouncement(raw, time.Time{}, time.Now(), nil)
	if !ok || item != "Cloak of Flames" {
		t.Errorf("DetectAnnouncement = (%q, %v), want (%q, true)", item, ok, "Cloak of Flames")
	}
}
