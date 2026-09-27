package bankexport

import "testing"

func TestSuggestFlags_NameMatchInUnflaggedBag(t *testing.T) {
	inv := invWith([]Container{
		bagContainer("Bank1", 900, "Hand Made Backpack", SlotItem{SlotIndex: 1, ItemID: 100, ItemName: "Old Sheet Widget"}),
	})
	unverified := []UnverifiedItem{{ItemName: "Old Sheet Widget", Quantity: 5, LegacyLocation: "Bank1-Slot1", Kind: "sheet"}}

	suggestions := SuggestFlags(inv, nil, unverified)
	if len(suggestions) != 1 {
		t.Fatalf("expected exactly 1 suggestion, got %d: %+v", len(suggestions), suggestions)
	}
	if suggestions[0].Container != "Bank1" {
		t.Errorf("expected the suggestion to point at Bank1, got %q", suggestions[0].Container)
	}
	if len(suggestions[0].Matches) != 1 || suggestions[0].Matches[0].ItemName != "Old Sheet Widget" {
		t.Errorf("expected the match to name the unverified item, got %+v", suggestions[0].Matches)
	}
}

func TestSuggestFlags_AlreadyFlaggedContainerNeverSuggested(t *testing.T) {
	inv := invWith([]Container{
		bagContainer("Bank1", 900, "Hand Made Backpack", SlotItem{SlotIndex: 1, ItemID: 100, ItemName: "Old Sheet Widget"}),
	})
	unverified := []UnverifiedItem{{ItemName: "Old Sheet Widget", Quantity: 5, Kind: "sheet"}}
	designated := []DesignatedSlot{{Container: "Bank1", SlotIndex: 0, ExpectedItemID: 900, ExpectedItemName: "Hand Made Backpack"}}

	suggestions := SuggestFlags(inv, designated, unverified)
	if len(suggestions) != 0 {
		t.Errorf("an already-flagged container should never be suggested, got %+v", suggestions)
	}
}

func TestSuggestFlags_NoMatchingItemAnywhere(t *testing.T) {
	inv := invWith([]Container{
		bagContainer("Bank1", 900, "Hand Made Backpack", SlotItem{SlotIndex: 1, ItemID: 100, ItemName: "Unrelated Item"}),
	})
	unverified := []UnverifiedItem{{ItemName: "Ghost Item", Quantity: 1, Kind: "sheet"}}

	suggestions := SuggestFlags(inv, nil, unverified)
	if len(suggestions) != 0 {
		t.Errorf("expected no suggestions when nothing matches, got %+v", suggestions)
	}
}

func TestSuggestFlags_SharedBankItemNeverMatchesPersonalContainer(t *testing.T) {
	inv := invWith([]Container{
		bagContainer("Bank1", 900, "Hand Made Backpack", SlotItem{SlotIndex: 1, ItemID: 100, ItemName: "Shared Widget"}),
	})
	// LegacyLocation says this item was recorded on SharedBank — a personal
	// Bank1 bag holding an identically-named item must never be suggested
	// as its home; a bag never crosses the personal/SharedBank boundary.
	unverified := []UnverifiedItem{{ItemName: "Shared Widget", Quantity: 1, LegacyLocation: "SharedBank2", Kind: "sheet"}}

	suggestions := SuggestFlags(inv, nil, unverified)
	if len(suggestions) != 0 {
		t.Errorf("a SharedBank-recorded item must never match a personal container, got %+v", suggestions)
	}
}

func TestSuggestFlags_MultipleUnverifiedItemsSameContainer(t *testing.T) {
	inv := invWith([]Container{
		bagContainer("Bank8", 700, "Deluxe Toolbox",
			SlotItem{SlotIndex: 1, ItemID: 100, ItemName: "Widget"},
			SlotItem{SlotIndex: 2, ItemID: 200, ItemName: "Gadget"},
		),
	})
	unverified := []UnverifiedItem{
		{ItemName: "Widget", Quantity: 1, Kind: "sheet"},
		{ItemName: "Gadget", Quantity: 1, Kind: "sheet"},
		{ItemName: "Nothing Here", Quantity: 1, Kind: "sheet"},
	}

	suggestions := SuggestFlags(inv, nil, unverified)
	if len(suggestions) != 1 {
		t.Fatalf("expected exactly 1 suggested container, got %d: %+v", len(suggestions), suggestions)
	}
	if len(suggestions[0].Matches) != 2 {
		t.Errorf("expected 2 matched items (Widget, Gadget) in Bank8, got %d: %+v", len(suggestions[0].Matches), suggestions[0].Matches)
	}
}

func TestSuggestFlags_EmptyUnverifiedReturnsEmpty(t *testing.T) {
	inv := invWith([]Container{
		bagContainer("Bank1", 900, "Hand Made Backpack", SlotItem{SlotIndex: 1, ItemID: 100, ItemName: "Widget"}),
	})
	suggestions := SuggestFlags(inv, nil, nil)
	if len(suggestions) != 0 {
		t.Errorf("expected an empty (never nil-ambiguous) slice with nothing unverified, got %+v", suggestions)
	}
}
