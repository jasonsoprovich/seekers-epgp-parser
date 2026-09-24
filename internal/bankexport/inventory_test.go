package bankexport

import (
	"testing"
)

func TestBuildInventory(t *testing.T) {
	exp, err := ParseExport("testdata/TestMule1-Inventory_pq.proj.txt")
	if err != nil {
		t.Fatalf("ParseExport: %v", err)
	}
	inv := BuildInventory(exp)

	if inv.Character != "TestMule1" {
		t.Errorf("Character = %q, want TestMule1", inv.Character)
	}

	// Currency must never appear anywhere in the view model.
	for _, c := range append(append([]Container{}, inv.Bags...), append(inv.Bank, inv.SharedBank...)...) {
		for _, item := range c.Items {
			if item.Category == CategoryCurrency {
				t.Errorf("currency leaked into Inventory: container %s item %+v", c.Container, item)
			}
		}
	}

	// Primary (equipped gear) shows up as Equipped, not a Bag/Bank container.
	foundEquipped := false
	for _, e := range inv.Equipped {
		if e.Location == "Primary" && e.ItemName == "Test Sword" {
			foundEquipped = true
		}
	}
	if !foundEquipped {
		t.Errorf("expected Primary/Test Sword in Equipped, got %+v", inv.Equipped)
	}

	// General1 is a real bag (Small Pouch, capacity 4): its own row is
	// never an item, only its contents (Health Potion) are.
	var general1 *Container
	for i := range inv.Bags {
		if inv.Bags[i].Container == "General1" {
			general1 = &inv.Bags[i]
		}
	}
	if general1 == nil {
		t.Fatal("expected a General1 bag")
	}
	if general1.Loose {
		t.Error("General1 should not be Loose — it has a real bag (Small Pouch)")
	}
	if general1.BagName != "Small Pouch" || general1.Capacity != 4 {
		t.Errorf("General1 bag descriptor = %q/%d, want Small Pouch/4", general1.BagName, general1.Capacity)
	}
	if len(general1.Items) != 1 || general1.Items[0].ItemName != "Health Potion" {
		t.Errorf("General1 items = %+v, want just Health Potion", general1.Items)
	}

	// Bank2 has no bag — a loose item sits directly in the slot.
	var bank2 *Container
	for i := range inv.Bank {
		if inv.Bank[i].Container == "Bank2" {
			bank2 = &inv.Bank[i]
		}
	}
	if bank2 == nil {
		t.Fatal("expected a Bank2 container")
	}
	if !bank2.Loose {
		t.Error("Bank2 should be Loose — no bag, just Test Ore sitting directly in the slot")
	}
	if len(bank2.Items) != 1 || bank2.Items[0].ItemName != "Test Ore" {
		t.Errorf("Bank2 items = %+v, want just Test Ore", bank2.Items)
	}

	// SharedBank1 lands in SharedBank, not Bank/Bags.
	foundSharedBank1 := false
	for _, c := range inv.SharedBank {
		if c.Container == "SharedBank1" {
			foundSharedBank1 = true
		}
	}
	if !foundSharedBank1 {
		t.Errorf("expected SharedBank1 in SharedBank, got %+v", inv.SharedBank)
	}
}

func TestSharedBankFingerprint(t *testing.T) {
	mule1, err := ParseExport("testdata/TestMule1-Inventory_pq.proj.txt")
	if err != nil {
		t.Fatalf("ParseExport(mule1): %v", err)
	}
	mule2, err := ParseExport("testdata/TestMule2-Inventory_pq.proj.txt")
	if err != nil {
		t.Fatalf("ParseExport(mule2): %v", err)
	}

	fp1 := SharedBankFingerprint(mule1)
	fp2 := SharedBankFingerprint(mule2)
	if fp1 == "" || fp2 == "" {
		t.Fatal("expected non-empty fingerprints for both mules")
	}
	if fp1 != fp2 {
		t.Errorf("same-account mules should have matching fingerprints: %s != %s", fp1, fp2)
	}

	empty := &Export{Character: "Nobody"}
	if got := SharedBankFingerprint(empty); got != "" {
		t.Errorf("empty SharedBank should fingerprint to \"\", got %q", got)
	}
}

func TestBuildSyncRows(t *testing.T) {
	exp, err := ParseExport("testdata/TestMule1-Inventory_pq.proj.txt")
	if err != nil {
		t.Fatalf("ParseExport: %v", err)
	}
	inv := BuildInventory(exp)

	// Only General1 designated guild — Bank2 and SharedBank1 must not appear.
	rows := BuildSyncRows(inv, map[string]bool{"General1": true}, false)
	if len(rows) != 1 || rows[0].ItemName != "Health Potion" {
		t.Errorf("rows = %+v, want just Health Potion from General1", rows)
	}
	for _, r := range rows {
		if r.Container == "General1" && r.SlotIndex == 0 {
			t.Error("the bag's own descriptor row (General1 slot 0) must never be synced")
		}
	}

	// Bank2 (loose item, no bag) designated guild: the item itself syncs.
	rows = BuildSyncRows(inv, map[string]bool{"Bank2": true}, false)
	if len(rows) != 1 || rows[0].ItemName != "Test Ore" {
		t.Errorf("rows = %+v, want just Test Ore from Bank2", rows)
	}

	// SharedBank1 designated but includeSharedBank=false: nothing syncs.
	rows = BuildSyncRows(inv, map[string]bool{"SharedBank1": true}, false)
	if len(rows) != 0 {
		t.Errorf("rows = %+v, want none — includeSharedBank was false", rows)
	}

	// Same designation with includeSharedBank=true: the bag's contents sync.
	rows = BuildSyncRows(inv, map[string]bool{"SharedBank1": true}, true)
	if len(rows) != 1 || rows[0].ItemName != "Shared Item A" {
		t.Errorf("rows = %+v, want just Shared Item A from SharedBank1", rows)
	}

	// Nothing designated: nothing syncs, and the result is never nil.
	rows = BuildSyncRows(inv, map[string]bool{}, true)
	if rows == nil {
		t.Error("BuildSyncRows must never return a nil slice")
	}
	if len(rows) != 0 {
		t.Errorf("rows = %+v, want none", rows)
	}

	// Currency is never syncable even if its container is somehow flagged.
	rows = BuildSyncRows(inv, map[string]bool{"General-Coin": true, "Bank-Coin": true}, true)
	if len(rows) != 0 {
		t.Errorf("currency containers produced rows: %+v", rows)
	}
}
