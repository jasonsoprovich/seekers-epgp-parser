package bankexport

import (
	"crypto/sha1"
	"encoding/hex"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ContainerKind groups a Container for display — which section of the
// Guild Bank tab (Bags/Bank/SharedBank) it belongs under.
type ContainerKind string

const (
	KindGeneral    ContainerKind = "general"
	KindBank       ContainerKind = "bank"
	KindSharedBank ContainerKind = "shared_bank"
)

var containerNumRe = regexp.MustCompile(`^(General|Bank|SharedBank)(\d+)$`)

// SlotItem is one item inside a Container, or the Container's own single
// item when Container.Loose is true.
type SlotItem struct {
	SlotIndex int      `json:"slotIndex"`
	Category  Category `json:"category"`
	ItemName  string   `json:"itemName"`
	ItemID    int      `json:"itemId"`
	Quantity  int      `json:"quantity"`
}

// Container is one top-level bag/bank slot — exactly the unit an officer
// designates as guild or personal (bank_slot_designations.container on
// the website). BagName/Capacity/BagItemID describe the bag sitting in
// this slot; Loose means there's no bag at all, just one item occupying
// the slot directly (Items has exactly one entry, at SlotIndex 0).
type Container struct {
	Container string        `json:"container"`
	Kind      ContainerKind `json:"kind"`
	Number    int           `json:"number"`
	BagName   string        `json:"bagName"`
	BagItemID int           `json:"bagItemId"`
	Capacity  int           `json:"capacity"`
	Loose     bool          `json:"loose"`
	Items     []SlotItem    `json:"items"`
}

// EquippedItem is a worn-gear row — read-only in the Guild Bank tab, never
// syncable.
type EquippedItem struct {
	Location string `json:"location"`
	ItemName string `json:"itemName"`
	ItemID   int    `json:"itemId"`
}

// Inventory is the display-ready view of one character's export — what
// the officer app's Guild Bank tab renders, and what BuildSyncRows reads
// designated containers out of. Currency is dropped entirely, at this
// layer, on the guild's own instruction: never tracked, never synced.
type Inventory struct {
	Character  string         `json:"character"`
	Equipped   []EquippedItem `json:"equipped"`
	Bags       []Container    `json:"bags"`
	Bank       []Container    `json:"bank"`
	SharedBank []Container    `json:"sharedBank"`
}

func containerMeta(container string) (kind ContainerKind, number int, ok bool) {
	m := containerNumRe.FindStringSubmatch(container)
	if m == nil {
		return "", 0, false
	}
	n, _ := strconv.Atoi(m[2])
	switch m[1] {
	case "General":
		return KindGeneral, n, true
	case "Bank":
		return KindBank, n, true
	case "SharedBank":
		return KindSharedBank, n, true
	}
	return "", 0, false
}

// buildContainers groups a flat Holding list (already restricted to
// General/Bank, or SharedBank, callers keep the two separate — see
// BuildInventory) into display Containers, sorted by container number.
func buildContainers(holdings []Holding) []Container {
	byContainer := map[string][]Holding{}
	for _, h := range holdings {
		if h.Category == CategoryCurrency {
			continue // never tracked (see Inventory's own doc comment)
		}
		byContainer[h.Container] = append(byContainer[h.Container], h)
	}

	out := make([]Container, 0, len(byContainer))
	for containerName, rows := range byContainer {
		kind, number, ok := containerMeta(containerName)
		if !ok {
			continue // shouldn't happen — buildContainers is only ever called with bag-shaped containers
		}
		sort.Slice(rows, func(i, j int) bool { return rows[i].SlotIndex < rows[j].SlotIndex })

		var descriptor *Holding
		var items []SlotItem
		for i := range rows {
			r := rows[i]
			if r.SlotIndex == 0 {
				d := r
				descriptor = &d
				continue
			}
			items = append(items, SlotItem{SlotIndex: r.SlotIndex, Category: r.Category, ItemName: r.ItemName, ItemID: r.ItemID, Quantity: r.Quantity})
		}

		c := Container{Container: containerName, Kind: kind, Number: number, Items: items}
		if descriptor != nil {
			if descriptor.BagSlots > 0 {
				// A real bag: its own row is structural, never a holding —
				// only what's inside it gets synced.
				c.BagName = descriptor.ItemName
				c.BagItemID = descriptor.ItemID
				c.Capacity = descriptor.BagSlots
			} else {
				// No bag — this top-level slot directly holds one item.
				c.Loose = true
				c.Items = []SlotItem{{SlotIndex: 0, Category: descriptor.Category, ItemName: descriptor.ItemName, ItemID: descriptor.ItemID, Quantity: descriptor.Quantity}}
			}
		}
		out = append(out, c)
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Number < out[j].Number })
	return out
}

// BuildInventory turns a parsed Export into the display-ready Inventory
// the Guild Bank tab renders. Equipped gear, Cursor/Held, and currency are
// never included — none of them can ever be flagged guild property.
func BuildInventory(exp *Export) *Inventory {
	var bags, bank []Holding
	equipped := []EquippedItem{}

	for _, h := range exp.Holdings {
		if h.Category == CategoryCurrency {
			continue
		}
		kind, _, ok := containerMeta(h.Container)
		switch {
		case ok && kind == KindGeneral:
			bags = append(bags, h)
		case ok && kind == KindBank:
			bank = append(bank, h)
		case h.Container == "Held" || h.Container == "Cursor":
			// Not equipped gear, not a bag — the cursor/held slot. Never
			// shown; it's a transient in-hand item, not a stash location.
			continue
		default:
			equipped = append(equipped, EquippedItem{Location: h.Container, ItemName: h.ItemName, ItemID: h.ItemID})
		}
	}

	sort.Slice(equipped, func(i, j int) bool { return equipped[i].Location < equipped[j].Location })

	return &Inventory{
		Character:  exp.Character,
		Equipped:   equipped,
		Bags:       buildContainers(bags),
		Bank:       buildContainers(bank),
		SharedBank: buildContainers(exp.SharedBank),
	}
}

// SharedBankFingerprint hashes an export's SharedBank contents (container,
// slot, item id/name, quantity — sorted, so row order never matters) so
// the officer app can auto-suggest "these characters share an account" by
// comparing two exports' fingerprints. Returns "" for an empty SharedBank
// so two characters with nothing in their shared bank never look like a
// match (PLAN.md §9 addendum: "two empty shared banks are never auto-
// grouped").
func SharedBankFingerprint(exp *Export) string {
	if len(exp.SharedBank) == 0 {
		return ""
	}
	rows := make([]string, len(exp.SharedBank))
	for i, h := range exp.SharedBank {
		rows[i] = h.Container + "|" + strconv.Itoa(h.SlotIndex) + "|" + strconv.Itoa(h.ItemID) + "|" + h.ItemName + "|" + strconv.Itoa(h.Quantity)
	}
	sort.Strings(rows)
	sum := sha1.Sum([]byte(strings.Join(rows, "\n")))
	return hex.EncodeToString(sum[:])
}

// BuildSyncRows is the ONLY path that turns an Inventory into upload rows
// — everything else (the Guild Bank tab's toggles, the preview modal) is
// display. guildContainers is the set of container names ("Bank12",
// "SharedBank2") the officer has flagged guild on the website for this
// character (personal) or its EQ account group (shared); a container not
// in that set is never synced, full stop — this is the local half of the
// "personal items never uploaded" guarantee (the server re-validates the
// same rule independently, never trusting this filtering alone). A bag's
// own descriptor row is never included — only its contents (or, for a
// loose top-level item, that one item).
func BuildSyncRows(inv *Inventory, guildContainers map[string]bool, includeSharedBank bool) []Holding {
	var out []Holding

	appendFrom := func(containers []Container) {
		for _, c := range containers {
			if !guildContainers[c.Container] {
				continue
			}
			for _, item := range c.Items {
				out = append(out, Holding{
					Container: c.Container,
					SlotIndex: item.SlotIndex,
					Category:  item.Category,
					ItemName:  item.ItemName,
					ItemID:    item.ItemID,
					Quantity:  item.Quantity,
				})
			}
		}
	}

	appendFrom(inv.Bags)
	appendFrom(inv.Bank)
	if includeSharedBank {
		appendFrom(inv.SharedBank)
	}

	if out == nil {
		out = []Holding{}
	}
	return out
}
