package items

import "testing"

func TestResolve_CarvedBoneRing(t *testing.T) {
	cases := []struct {
		name      string
		hint      Hint
		wantID    int
		reason    string
		ambiguous bool
	}{
		{"zone picks the overland copy", Hint{Zone: "The Grey"}, 6441, ReasonZone, false},
		{"zone picks the raid copy", Hint{Zone: "The Lair of Terris Thule"}, 10127, ReasonZone, false},
		{"kill beats zone", Hint{Zone: "The Grey", Killed: []string{"Terris Thule"}}, 10127, ReasonKill, false},
		{"latest relevant kill wins", Hint{Killed: []string{"a grey wolf", "Crusader Kezzal", "Terris Thule"}}, 6441, ReasonKill, false},
		{"no context falls back to level", Hint{}, 10127, ReasonLevel, true},
		{"unrelated zone falls back to level", Hint{Zone: "The Bazaar"}, 10127, ReasonLevel, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r, ok := Resolve("carved bone ring", c.hint)
			if !ok {
				t.Fatal("not found")
			}
			if r.Item.ID != c.wantID || r.Reason != c.reason || r.Ambiguous != c.ambiguous {
				t.Errorf("got id=%d reason=%s ambiguous=%v, want id=%d reason=%s ambiguous=%v", r.Item.ID, r.Reason, r.Ambiguous, c.wantID, c.reason, c.ambiguous)
			}
			if len(r.Variants) != 2 || r.Variants[0].ID != 10127 {
				t.Errorf("variants = %+v, want both copies, highest level first", r.Variants)
			}
		})
	}
}

func TestResolve_SingleIDHasNoVariants(t *testing.T) {
	r, ok := Resolve("Denon's Drums of Declivity", Hint{})
	if !ok || r.Item.ID != 28149 || r.Reason != ReasonOnly || r.Variants != nil || r.Ambiguous {
		t.Errorf("got %+v", r)
	}
}

func TestResolve_SameNPCStaysAmbiguous(t *testing.T) {
	// Both Pallid Claws drop from the same Akheva Ruins NPCs; nothing in the
	// log can separate them.
	r, ok := Resolve("Pallid Claws", Hint{Zone: "Akheva Ruins", Killed: []string{"Sheleric Vis"}})
	if !ok || !r.Ambiguous || r.Item.ID != 7541 {
		t.Errorf("got id=%d ambiguous=%v reason=%s, want 7541 ambiguous", r.Item.ID, r.Ambiguous, r.Reason)
	}
}

func TestNormalizeZoneAndNPC(t *testing.T) {
	if got := normalizeZone("Plane of Fear (Instanced)"); got != "plane of fear" {
		t.Errorf("normalizeZone = %q", got)
	}
	if normalizeZone("The Grey") != normalizeZone("grey") {
		t.Error("leading The should not matter")
	}
	if got := normalizeNPC("#Avatar_of_Earth"); got != normalizeNPC("Avatar of Earth") {
		t.Errorf("normalizeNPC = %q", got)
	}
	if got := normalizeNPC("a_lightcrawler01"); got != "a lightcrawler" {
		t.Errorf("normalizeNPC = %q", got)
	}
	if normalizeNPC("Shik`nar_Warrior") != normalizeNPC("Shik'nar Warrior") {
		t.Error("backtick should fold to apostrophe")
	}
}

func TestByID(t *testing.T) {
	it, ok := ByID(6441)
	if !ok || it.Name != "Carved Bone Ring" {
		t.Errorf("ByID(6441) = %+v, %v", it, ok)
	}
}
