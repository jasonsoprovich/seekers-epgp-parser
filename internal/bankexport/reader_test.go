package bankexport

import (
	"reflect"
	"testing"
)

func TestCharacterFromFileName(t *testing.T) {
	cases := map[string]string{
		"TestMule1-Inventory_pq.proj.txt": "TestMule1",
		"TestMule2-Inventory.txt":         "TestMule2",
		"not-an-export.txt":               "",
	}
	for name, want := range cases {
		if got := CharacterFromFileName(name); got != want {
			t.Errorf("CharacterFromFileName(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestParseExport(t *testing.T) {
	exp, err := ParseExport("testdata/TestMule1-Inventory_pq.proj.txt")
	if err != nil {
		t.Fatalf("ParseExport: %v", err)
	}
	if exp.Character != "TestMule1" {
		t.Errorf("Character = %q, want TestMule1", exp.Character)
	}

	// Empty rows dropped: Head, General1-Slot2, Bank1, SharedBank30 never
	// show up in either bucket.
	for _, h := range append(append([]Holding{}, exp.Holdings...), exp.SharedBank...) {
		if h.ItemName == "Empty" || h.ItemName == "" {
			t.Errorf("an Empty/blank row leaked through as a Holding: %+v", h)
		}
	}

	wantHoldings := []Holding{
		{Container: "Primary", SlotIndex: 0, Category: CategoryItem, ItemName: "Test Sword", ItemID: 100, Quantity: 1},
		{Container: "General1", SlotIndex: 0, Category: CategoryItem, ItemName: "Small Pouch", ItemID: 200, Quantity: 1},
		{Container: "General1", SlotIndex: 1, Category: CategoryItem, ItemName: "Health Potion", ItemID: 201, Quantity: 5},
		{Container: "General2", SlotIndex: 1, Category: CategorySpell, ItemName: "Spell: Test Spell", ItemID: 500, Quantity: 1},
		{Container: "General-Coin", SlotIndex: 0, Category: CategoryCurrency, ItemName: "Currency", ItemID: 0, Quantity: 12345},
		{Container: "Bank2", SlotIndex: 0, Category: CategoryItem, ItemName: "Test Ore", ItemID: 300, Quantity: 10},
	}
	if !reflect.DeepEqual(exp.Holdings, wantHoldings) {
		t.Errorf("Holdings mismatch:\n got  %+v\n want %+v", exp.Holdings, wantHoldings)
	}

	// Dead slots (11-30) never appear even when the raw row isn't "Empty"
	// (SharedBank11/SharedBank11-Slot3 both carry real names in the
	// fixture, specifically to prove they still get dropped).
	wantSharedBank := []Holding{
		{Container: "SharedBank1", SlotIndex: 0, Category: CategoryItem, ItemName: "Shared Bag", ItemID: 400, Quantity: 1},
		{Container: "SharedBank1", SlotIndex: 1, Category: CategoryItem, ItemName: "Shared Item A", ItemID: 401, Quantity: 2},
		{Container: "SharedBank10", SlotIndex: 0, Category: CategoryItem, ItemName: "Last Real Slot Item", ItemID: 410, Quantity: 1},
		{Container: "Bank-Coin", SlotIndex: 0, Category: CategoryCurrency, ItemName: "Currency", ItemID: 0, Quantity: 999999},
	}
	if !reflect.DeepEqual(exp.SharedBank, wantSharedBank) {
		t.Errorf("SharedBank mismatch:\n got  %+v\n want %+v", exp.SharedBank, wantSharedBank)
	}
}

// TestSharedBankIsAccountWide is the regression guard for the 2026-08-24
// finding (PLAN.md §3 addendum): two characters on the same account
// produce byte-identical SharedBank/Bank-Coin content, which is exactly
// what makes the "one mule per account reports it" design (data/imports/
// bank/README.md) sound — there's nothing character-specific in this
// bucket to lose by only importing it once.
func TestSharedBankIsAccountWide(t *testing.T) {
	mule1, err := ParseExport("testdata/TestMule1-Inventory_pq.proj.txt")
	if err != nil {
		t.Fatalf("ParseExport(mule1): %v", err)
	}
	mule2, err := ParseExport("testdata/TestMule2-Inventory_pq.proj.txt")
	if err != nil {
		t.Fatalf("ParseExport(mule2): %v", err)
	}

	if !reflect.DeepEqual(mule1.SharedBank, mule2.SharedBank) {
		t.Errorf("SharedBank differs between two same-account mules:\n mule1 %+v\n mule2 %+v", mule1.SharedBank, mule2.SharedBank)
	}
	// Their personal Holdings must NOT match — otherwise this fixture pair
	// wouldn't actually be testing anything about the shared/personal
	// split.
	if reflect.DeepEqual(mule1.Holdings, mule2.Holdings) {
		t.Fatal("fixture bug: mule1 and mule2 Holdings are identical, so this test can't distinguish shared from personal data")
	}
}
