// Package bankexport parses a Zeal in-game inventory export
// ("<CharName>-Inventory.txt" / "<CharName>-Inventory_pq.proj.txt") into
// the shape seekers-tracker's bank_holdings table expects (PLAN.md §3,
// §4f, §11 Phase 8). The parsing logic — file format, both filename
// variants, the SharedBank real-slot ceiling — is ported from the sibling
// pq-companion repo's internal/zeal package rather than reinvented; see
// that repo's reader.go/scanner.go and frontend/src/lib/
// inventoryLocations.ts for the reference implementation this was
// verified against.
package bankexport

import "time"

// Category mirrors bank_holdings.category. "currency" is not a real Zeal
// export field — it's how a "-Coin" row (General-Coin, Bank-Coin) is
// classified, so the guild bank's "total currency" figure is a plain sum
// over category = currency rather than a name-string special case.
type Category string

const (
	CategoryItem     Category = "item"
	CategorySpell    Category = "spell"
	CategoryCurrency Category = "currency"
)

// Holding is one physical stack, shaped to map directly onto a
// bank_holdings row. Container/SlotIndex decompose the export's raw
// Location column exactly the way bank_holdings stores them (see
// location.go): Container is the bag identifier ("General1", "Bank12",
// "SharedBank2") for a bag and its contents, or the raw location string
// for anything that isn't a bag ("Head", "Bank-Coin", "Held"). SlotIndex
// is 0 for a bag's own row or any non-bag row, 1..N for a slot inside a
// bag.
type Holding struct {
	Container string
	SlotIndex int
	Category  Category
	ItemName  string
	// ItemID is the export's own EQ item ID — 0 for a currency row (the
	// export has no item ID for coin, since it isn't an item).
	ItemID   int
	Quantity int
}

// Export is the full parsed state of one character's inventory/bank
// export.
type Export struct {
	Character  string
	ExportedAt time.Time
	// Holdings excludes SharedBank/Bank-Coin — see SharedBank below.
	Holdings []Holding
	// SharedBank holds this export's SharedBank*/Bank-Coin rows
	// separately, real slots only (1-10 — PQ never populates 11-30 even
	// though the export always carries all 30 modern-client slots; see
	// sharedBankSlotInRange). These are account-wide, not per-character
	// (confirmed 2026-08-24 against two characters on one real account —
	// PLAN.md §3 addendum): two mules on the same account produce
	// byte-identical SharedBank content. That's why this package splits
	// them out rather than folding them into Holdings — the caller (the
	// officer, via the "this mule reports SharedBank/Bank-Coin" toggle
	// design in data/imports/bank/README.md) decides whether to include
	// them at all, and at most one mule per real account ever should.
	SharedBank []Holding
}
