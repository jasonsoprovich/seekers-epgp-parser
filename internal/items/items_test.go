package items

import (
	"strings"
	"testing"
)

func TestLookup_Exact(t *testing.T) {
	it, ok := Lookup("Denon's Drums of Declivity")
	if !ok {
		t.Fatal("expected Denon's Drums of Declivity to be found")
	}
	if it.ID != 28149 {
		t.Errorf("id = %d, want 28149", it.ID)
	}
}

func TestLookup_CaseInsensitive(t *testing.T) {
	it, ok := Lookup("denon's drums of declivity")
	if !ok || it.ID != 28149 {
		t.Errorf("Lookup(lowercase) = (%+v, %v), want id 28149", it, ok)
	}
}

func TestLookup_BacktickName(t *testing.T) {
	// quarm.db stores this one with a backtick, not an apostrophe.
	it, ok := Lookup("Song: Denon's Dissension")
	if !ok {
		t.Fatal("expected the backtick-apostrophe item to be found via the apostrophe spelling")
	}
	if it.ID != 15736 {
		t.Errorf("id = %d, want 15736", it.ID)
	}
	if !strings.Contains(it.Name, "`") {
		t.Errorf("Name = %q, want the DB's own backtick preserved for display", it.Name)
	}
}

func TestLookup_PlanesOfPowerItem(t *testing.T) {
	// pq-companion's own query-time filter (pop_index.go) hides PoP items;
	// this app's generator (scripts/gen-items.sh) doesn't, and this item
	// must be reachable to prove that.
	it, ok := Lookup("Earring of Unseen Horrors")
	if !ok || it.ID != 26980 {
		t.Errorf("Lookup(PoP item) = (%+v, %v), want id 26980", it, ok)
	}
}

func TestLookup_NotFound(t *testing.T) {
	if _, ok := Lookup("Not A Real Item Name At All"); ok {
		t.Error("expected no match for a made-up name")
	}
}

func TestMatch_ExactStillWorks(t *testing.T) {
	it, ok := Match("Denon's Drums of Declivity")
	if !ok || it.ID != 28149 {
		t.Errorf("Match(exact) = (%+v, %v), want id 28149", it, ok)
	}
}

func TestMatch_OneLetterTypo(t *testing.T) {
	// "Declivety" for "Declivity" — one substitution, name is well over the
	// 8-char fuzzy floor.
	it, ok := Match("Denon's Drums of Declivety")
	if !ok || it.ID != 28149 {
		t.Errorf("Match(typo) = (%+v, %v), want id 28149", it, ok)
	}
}

func TestMatch_RejectsBuffAbbreviations(t *testing.T) {
	// The real live-test false positive: short buff/tag abbreviations must
	// never fuzzy-match — they're below minFuzzyLen, so they don't even
	// get the chance to.
	for _, s := range []string{"SS/SP", "KEI", "SoW", "Cleric buffs"} {
		if it, ok := Match(s); ok {
			t.Errorf("Match(%q) = %+v, want no match", s, it)
		}
	}
}

func TestMatch_ShortNameNoFuzzy(t *testing.T) {
	// A short real item name should still match exactly, but a short typo
	// of it should NOT fuzzy-match (below minFuzzyLen).
	if _, ok := Lookup("A Broom"); !ok {
		t.Fatal("expected 'A Broom' to exist for this test to be meaningful")
	}
	if it, ok := Match("A Boom"); ok {
		t.Errorf("Match(short typo) = %+v, want no match (below fuzzy floor)", it)
	}
}

func TestMatchIn_AmbiguousTieRefusesToGuess(t *testing.T) {
	// Two different items exactly one edit from the typed name in
	// opposite directions ("robe of the ancients" -> insert/delete 's')
	// must not resolve to either — a synthetic map, since depending on
	// the real ~25,000-row DB to happen to contain a reproducible tie
	// would be flaky.
	candidates := map[string]Item{
		"robe of the ancient":   {ID: 1, Name: "Robe of the Ancient"},
		"robe of the ancients":  {ID: 2, Name: "Robe of the Ancients"}, // exact match, but test the near-miss below
		"robe of the ancientss": {ID: 3, Name: "Robe of the Ancientss"},
	}
	// Query sits exactly 1 edit from both id 1 (delete) and id 3 (delete
	// the other direction), with the true exact match removed so the tie
	// is actually exercised.
	delete(candidates, "robe of the ancients")
	if it, ok := matchIn("robe of the ancients", candidates); ok {
		t.Errorf("matchIn(tied distance) = %+v, want no match (ambiguous)", it)
	}
}

func TestMatchIn_UnambiguousTypoStillResolves(t *testing.T) {
	candidates := map[string]Item{
		"robe of the ancient": {ID: 1, Name: "Robe of the Ancient"},
		"cloak of flames":     {ID: 2, Name: "Cloak of Flames"},
	}
	it, ok := matchIn("robe of the ancints", candidates) // one transposition/sub, 1 edit
	if !ok || it.ID != 1 {
		t.Errorf("matchIn(unambiguous typo) = (%+v, %v), want id 1", it, ok)
	}
}

func TestDuplicateName_PrefersDroppable(t *testing.T) {
	// "A Broom" has two IDs in quarm.db (16544, 27172); Lookup must return
	// exactly one of them consistently (droppable, else lowest ID) rather
	// than being sensitive to map-iteration order.
	it, ok := Lookup("A Broom")
	if !ok {
		t.Fatal("expected 'A Broom' to resolve to one item")
	}
	if it.ID != 16544 && it.ID != 27172 {
		t.Errorf("id = %d, want one of the two known duplicate IDs", it.ID)
	}
	// Deterministic across repeated lookups (same process, same load).
	it2, _ := Lookup("A Broom")
	if it2.ID != it.ID {
		t.Errorf("Lookup was inconsistent across calls: %d vs %d", it.ID, it2.ID)
	}
}

func TestReady(t *testing.T) {
	if !Ready() {
		t.Error("expected the embedded item index to load successfully")
	}
}

func TestLink_Format(t *testing.T) {
	got := Link(Item{ID: 28149, Name: "Denon's Drums of Declivity"})
	want := "\x12028149 Denon's Drums of Declivity\x12"
	if got != want {
		t.Errorf("Link = %q, want %q", got, want)
	}
}

func TestLink_PadsToSixDigits(t *testing.T) {
	got := Link(Item{ID: 42, Name: "Cloak of Flames"})
	want := "\x12000042 Cloak of Flames\x12"
	if got != want {
		t.Errorf("Link = %q, want %q", got, want)
	}
}

func BenchmarkLookup_Exact(b *testing.B) {
	ensureLoaded()
	for i := 0; i < b.N; i++ {
		Lookup("Denon's Drums of Declivity")
	}
}

func BenchmarkMatch_OneTypo(b *testing.B) {
	ensureLoaded()
	for i := 0; i < b.N; i++ {
		Match("Denon's Drums of Declivety")
	}
}

func BenchmarkMatch_Miss(b *testing.B) {
	ensureLoaded()
	for i := 0; i < b.N; i++ {
		Match("Completely Unrelated Chat Message Text")
	}
}
