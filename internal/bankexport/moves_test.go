package bankexport

import "testing"

func invWith(bank []Container) *Inventory {
	return &Inventory{Character: "TestMule", Bank: bank}
}

func bagContainer(container string, bagID int, bagName string, items ...SlotItem) Container {
	return Container{Container: container, Kind: KindBank, BagItemID: bagID, BagName: bagName, Items: items}
}

func TestDetectMoves_NoChangeNoWarning(t *testing.T) {
	inv := invWith([]Container{
		bagContainer("Bank1", 900, "Hand Made Backpack", SlotItem{SlotIndex: 1, ItemID: 100, ItemName: "Widget"}),
	})
	designated := []DesignatedSlot{{Container: "Bank1", SlotIndex: 0, ExpectedItemID: 900, ExpectedItemName: "Hand Made Backpack"}}

	warnings := DetectMoves(inv, designated)
	if len(warnings) != 0 {
		t.Errorf("expected no warnings for an unchanged inventory, got %+v", warnings)
	}
}

func TestDetectMoves_FreshDesignationNeverWarns(t *testing.T) {
	// ExpectedItemID/Name both zero — a designation flagged this session,
	// never yet scanned/synced — must never warn regardless of what's there.
	inv := invWith([]Container{
		bagContainer("Bank1", 900, "Hand Made Backpack", SlotItem{SlotIndex: 1, ItemID: 100, ItemName: "Widget"}),
	})
	designated := []DesignatedSlot{{Container: "Bank1", SlotIndex: 0}}

	warnings := DetectMoves(inv, designated)
	if len(warnings) != 0 {
		t.Errorf("a never-scanned designation must never warn, got %+v", warnings)
	}
}

func TestDetectMoves_BagSwappedBetweenBankSlots_SingleSuggestion(t *testing.T) {
	// The guild bag (id 900) that WAS at Bank1 is now at Bank3; Bank1 now
	// holds a different, undesignated bag.
	inv := invWith([]Container{
		bagContainer("Bank1", 950, "Some Other Bag", SlotItem{SlotIndex: 1, ItemID: 111, ItemName: "Not Guild Stuff"}),
		bagContainer("Bank2", 800, "A Personal Bag", SlotItem{SlotIndex: 1, ItemID: 222, ItemName: "Personal Item"}),
		bagContainer("Bank3", 900, "Hand Made Backpack", SlotItem{SlotIndex: 1, ItemID: 100, ItemName: "Widget"}),
	})
	designated := []DesignatedSlot{{Container: "Bank1", SlotIndex: 0, ExpectedItemID: 900, ExpectedItemName: "Hand Made Backpack"}}

	warnings := DetectMoves(inv, designated)
	if len(warnings) != 1 {
		t.Fatalf("expected exactly 1 warning, got %d: %+v", len(warnings), warnings)
	}
	w := warnings[0]
	if w.Container != "Bank1" || w.SlotIndex != 0 {
		t.Errorf("warning on wrong position: %+v", w)
	}
	if w.FoundItemID != 950 || w.FoundItemName != "Some Other Bag" {
		t.Errorf("FoundItem should describe what's at Bank1 now, got id=%d name=%q", w.FoundItemID, w.FoundItemName)
	}
	if !w.HasSuggestion || w.SuggestedContainer != "Bank3" || w.SuggestedSlotIndex != 0 {
		t.Errorf("expected a single suggestion pointing at Bank3, got %+v", w)
	}
}

func TestDetectMoves_TwoIdenticalBags_AmbiguousNoSingleSuggestion(t *testing.T) {
	// Two undesignated bags share the SAME item id as the expected guild
	// bag — bags of the same type are indistinguishable from the export
	// alone, so this must come back as ambiguous (2 candidates, no single
	// HasSuggestion), matching what the real limitation actually is rather
	// than pretending contents alone can always disambiguate them.
	inv := invWith([]Container{
		bagContainer("Bank1", 950, "Some Other Bag"),
		bagContainer("Bank2", 900, "Hand Made Backpack", SlotItem{SlotIndex: 1, ItemID: 100, ItemName: "Widget"}),
		bagContainer("Bank3", 900, "Hand Made Backpack", SlotItem{SlotIndex: 1, ItemID: 999, ItemName: "Different Contents"}),
	})
	designated := []DesignatedSlot{{Container: "Bank1", SlotIndex: 0, ExpectedItemID: 900, ExpectedItemName: "Hand Made Backpack"}}

	warnings := DetectMoves(inv, designated)
	if len(warnings) != 1 {
		t.Fatalf("expected exactly 1 warning, got %d", len(warnings))
	}
	w := warnings[0]
	if w.HasSuggestion {
		t.Errorf("an ambiguous match (2 identical bags) must not auto-suggest one, got %+v", w)
	}
	if len(w.Candidates) != 2 {
		t.Errorf("expected 2 candidates for the officer to pick from, got %d: %+v", len(w.Candidates), w.Candidates)
	}
}

func TestDetectMoves_SubSlotItemMoved_SingleSuggestion(t *testing.T) {
	// A sub-slot-flagged item (a specific item inside a bag, not the whole
	// bag) moved to a different slot in a different bag.
	inv := invWith([]Container{
		bagContainer("Bank1", 950, "Guild Bag",
			SlotItem{SlotIndex: 1, ItemID: 111, ItemName: "Something Else Now"},
		),
		bagContainer("Bank2", 951, "Another Bag",
			SlotItem{SlotIndex: 3, ItemID: 700, ItemName: "Spell: Blessing of Aegolism"},
		),
	})
	designated := []DesignatedSlot{{Container: "Bank1", SlotIndex: 1, ExpectedItemID: 700, ExpectedItemName: "Spell: Blessing of Aegolism"}}

	warnings := DetectMoves(inv, designated)
	if len(warnings) != 1 {
		t.Fatalf("expected exactly 1 warning, got %d: %+v", len(warnings), warnings)
	}
	w := warnings[0]
	if w.Container != "Bank1" || w.SlotIndex != 1 {
		t.Errorf("warning on wrong position: %+v", w)
	}
	if !w.HasSuggestion || w.SuggestedContainer != "Bank2" || w.SuggestedSlotIndex != 3 {
		t.Errorf("expected a single suggestion pointing at Bank2 slot 3, got %+v", w)
	}
}

func TestDetectMoves_EmptySlotNoCandidates(t *testing.T) {
	// The bag is simply gone (emptied, nothing put there) and nothing
	// elsewhere matches — no suggestion at all, UI falls back to its own
	// "empty — bag moved?" badge.
	inv := invWith([]Container{
		bagContainer("Bank2", 800, "A Personal Bag", SlotItem{SlotIndex: 1, ItemID: 222, ItemName: "Personal Item"}),
	})
	designated := []DesignatedSlot{{Container: "Bank1", SlotIndex: 0, ExpectedItemID: 900, ExpectedItemName: "Hand Made Backpack"}}

	warnings := DetectMoves(inv, designated)
	if len(warnings) != 1 {
		t.Fatalf("expected exactly 1 warning, got %d", len(warnings))
	}
	w := warnings[0]
	if w.FoundItemID != 0 || w.FoundItemName != "" {
		t.Errorf("expected a fully-empty found identity, got id=%d name=%q", w.FoundItemID, w.FoundItemName)
	}
	if w.HasSuggestion || len(w.Candidates) != 0 {
		t.Errorf("expected no candidates at all, got %+v", w)
	}
}

func TestDetectMoves_NeverReturnsNil(t *testing.T) {
	warnings := DetectMoves(invWith(nil), nil)
	if warnings == nil {
		t.Error("DetectMoves must never return a nil slice")
	}
}
