package bankexport

import (
	"regexp"
	"strconv"
)

// bagSlotRe/bagContainerRe are ported from pq-companion's
// frontend/src/lib/inventoryLocations.ts (BAG_SLOT_RE/BAG_CONTAINER_RE) —
// bag containers and slots use either ":" or "-" as separator depending
// on the Zeal version, so both are accepted.
var (
	bagSlotRe      = regexp.MustCompile(`^(General|Bank|SharedBank)(\d+)[:\-]Slot(\d+)$`)
	bagContainerRe = regexp.MustCompile(`^(General|Bank|SharedBank)(\d+)$`)
)

// decomposeLocation maps a raw export Location string onto the
// (container, slotIndex) pair bank_holdings stores. A bag's own row (the
// bag item sitting in a top-level General/Bank/SharedBank slot) gets
// slotIndex 0; a row inside that bag gets its "-SlotN" number. Anything
// that isn't a bag (equipped gear, Held, Cursor, a "-Coin" row) uses the
// raw location as its own container with slotIndex 0 — it's already
// unique on its own, one row per character.
func decomposeLocation(location string) (container string, slotIndex int) {
	if m := bagSlotRe.FindStringSubmatch(location); m != nil {
		slot, _ := strconv.Atoi(m[3])
		return m[1] + m[2], slot
	}
	if m := bagContainerRe.FindStringSubmatch(location); m != nil {
		return m[1] + m[2], 0
	}
	return location, 0
}

// maxSharedBankSlot: Project Quarm never populates SharedBank slots past
// 10, even though Zeal's export always lists all 30 modern-client slots —
// pq-companion's scanner.go found this (maxSharedBankSlot there); 11-30
// are dead rows on this server, dropped here rather than imported as
// permanently-empty guild bank slots.
const maxSharedBankSlot = 10

var sharedBankNumRe = regexp.MustCompile(`^SharedBank(\d+)`)

// sharedBankClass classifies location for Export's Holdings/SharedBank
// split. Any "SharedBank"-prefixed location (container or "-SlotN" form)
// belongs to the shared-bank realm regardless of number — it's an
// account resource even where this server currently never populates it
// (11-30) — so those never fall through to the regular per-character
// Holdings bucket, they're dropped outright. Bank-Coin is the one
// non-"SharedBank"-named location that's also account-shared, confirmed
// against the 2026-08-24 reference exports.
type sharedBankClass int

const (
	notSharedBank sharedBankClass = iota
	sharedBankReal                // real slot (1-10) or Bank-Coin — keep
	sharedBankDead                // slot 11-30 — this server never populates it, drop
)

func classifySharedBank(location string) sharedBankClass {
	if location == "Bank-Coin" {
		return sharedBankReal
	}
	m := sharedBankNumRe.FindStringSubmatch(location)
	if m == nil {
		return notSharedBank
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return notSharedBank
	}
	if n >= 1 && n <= maxSharedBankSlot {
		return sharedBankReal
	}
	return sharedBankDead
}
