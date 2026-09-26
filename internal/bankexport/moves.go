package bankexport

import "strings"

// DesignatedSlot is one flagged position plus what was expected there —
// mirrors officerapi.DesignationSlot without importing that package (this
// package stays free of any tracker-API dependency, same reasoning
// internal/parse stays free of internal/items — see CLAUDE.md). SlotIndex
// 0 means the whole top-level container; 1..N means one item inside a bag.
type DesignatedSlot struct {
	Container        string
	SlotIndex        int
	ExpectedItemID   int
	ExpectedItemName string
}

// MoveCandidate is one plausible "this is probably where it went" match
// found while resolving a MoveWarning.
type MoveCandidate struct {
	Container string
	SlotIndex int
}

// MoveWarning flags a designated position whose current occupant doesn't
// match what was expected the last time it was flagged or synced — most
// often because the officer moved a guild-flagged bag to a different
// slot in-game, or moved/removed a specific item that was individually
// flagged. See the status artifact linked from CLAUDE.md for the design
// rationale behind detect+suggest+block, and this file's DetectMoves doc
// comment for exactly how a suggestion is found.
type MoveWarning struct {
	Container        string
	SlotIndex        int
	ExpectedItemID   int
	ExpectedItemName string
	// FoundItemID/FoundItemName is whatever occupies the position now —
	// both zero/"" if the position is genuinely empty (the old
	// "empty — bag moved?" case).
	FoundItemID   int
	FoundItemName string
	// HasSuggestion is true only when exactly one plausible match was
	// found — an ambiguous match (2+ candidates) is left for the officer
	// to pick from Candidates instead of guessing.
	HasSuggestion      bool
	SuggestedContainer string
	SuggestedSlotIndex int
	Candidates         []MoveCandidate
}

func allContainers(inv *Inventory) []Container {
	out := make([]Container, 0, len(inv.Bags)+len(inv.Bank)+len(inv.SharedBank))
	out = append(out, inv.Bags...)
	out = append(out, inv.Bank...)
	out = append(out, inv.SharedBank...)
	return out
}

func isSharedContainerName(name string) bool {
	return strings.HasPrefix(name, "SharedBank")
}

// containerIdentity is "what's occupying this top-level slot" — a real
// bag's own item id/name, or (Loose) the one item sitting directly in the
// slot. Zero/"" for a container with nothing recognizable in it.
func containerIdentity(c Container) (id int, name string) {
	if !c.Loose {
		return c.BagItemID, c.BagName
	}
	if len(c.Items) > 0 {
		return c.Items[0].ItemID, c.Items[0].ItemName
	}
	return 0, ""
}

// FindOccupant resolves what currently sits at one designated position —
// the container's own bag/loose identity for SlotIndex 0, or a specific
// item's identity for SlotIndex N. found is false when the position is
// entirely empty (no such container, or no item at that sub-slot).
func FindOccupant(inv *Inventory, container string, slotIndex int) (id int, name string, found bool) {
	var target *Container
	for _, c := range allContainers(inv) {
		if c.Container == container {
			cc := c
			target = &cc
			break
		}
	}
	if target == nil {
		return 0, "", false
	}
	if slotIndex == 0 {
		id, name = containerIdentity(*target)
		return id, name, id != 0 || name != ""
	}
	for _, item := range target.Items {
		if item.SlotIndex == slotIndex {
			return item.ItemID, item.ItemName, true
		}
	}
	return 0, "", false
}

func identityMatches(expectedID int, expectedName string, foundID int, foundName string) bool {
	if expectedID == 0 && expectedName == "" {
		return true // nothing recorded yet (a designation flagged this session, never scanned before) — never a mismatch
	}
	if expectedID != 0 && foundID != 0 {
		return expectedID == foundID
	}
	return strings.EqualFold(expectedName, foundName)
}

// DetectMoves compares every designated position against the CURRENT
// export and flags one whose occupant no longer matches what was
// expected. For a mismatch, it searches for where the expected bag/item
// probably ended up: for a whole-container (SlotIndex 0) designation,
// among every OTHER top-level container in the same realm (personal vs.
// SharedBank — a bag never crosses that boundary) that isn't already
// designated somewhere; for a sub-slot designation, among every item in
// the whole inventory. A single match becomes a one-click suggestion; 2+
// matches (e.g. two identical bags) are left as Candidates for the
// officer to pick from rather than guessed at; zero matches means no
// suggestion at all — the UI falls back to its plain "empty — bag moved?"
// badge. This is a best-effort LOCAL check only, not the server's own
// guarantee: the server independently re-validates every synced row's
// container against live designations regardless of what this function
// concludes.
func DetectMoves(inv *Inventory, designated []DesignatedSlot) []MoveWarning {
	designatedContainers := map[string]bool{}
	for _, d := range designated {
		designatedContainers[d.Container] = true
	}

	var warnings []MoveWarning
	for _, d := range designated {
		foundID, foundName, _ := FindOccupant(inv, d.Container, d.SlotIndex)
		if identityMatches(d.ExpectedItemID, d.ExpectedItemName, foundID, foundName) {
			continue
		}

		w := MoveWarning{Container: d.Container, SlotIndex: d.SlotIndex, ExpectedItemID: d.ExpectedItemID, ExpectedItemName: d.ExpectedItemName, FoundItemID: foundID, FoundItemName: foundName}

		if d.SlotIndex == 0 {
			shared := isSharedContainerName(d.Container)
			for _, c := range allContainers(inv) {
				if c.Container == d.Container || designatedContainers[c.Container] {
					continue // its own (already handled) slot, or anything already flagged elsewhere
				}
				if isSharedContainerName(c.Container) != shared {
					continue // a bag never crosses the personal/SharedBank boundary
				}
				cid, cname := containerIdentity(c)
				if cid == 0 && cname == "" {
					continue
				}
				if (d.ExpectedItemID != 0 && cid == d.ExpectedItemID) || (d.ExpectedItemID == 0 && d.ExpectedItemName != "" && strings.EqualFold(cname, d.ExpectedItemName)) {
					w.Candidates = append(w.Candidates, MoveCandidate{Container: c.Container, SlotIndex: 0})
				}
			}
		} else {
			for _, c := range allContainers(inv) {
				for _, item := range c.Items {
					if c.Container == d.Container && item.SlotIndex == d.SlotIndex {
						continue
					}
					if (d.ExpectedItemID != 0 && item.ItemID == d.ExpectedItemID) || (d.ExpectedItemID == 0 && d.ExpectedItemName != "" && strings.EqualFold(item.ItemName, d.ExpectedItemName)) {
						w.Candidates = append(w.Candidates, MoveCandidate{Container: c.Container, SlotIndex: item.SlotIndex})
					}
				}
			}
		}

		if len(w.Candidates) == 1 {
			w.HasSuggestion = true
			w.SuggestedContainer = w.Candidates[0].Container
			w.SuggestedSlotIndex = w.Candidates[0].SlotIndex
		}
		warnings = append(warnings, w)
	}

	if warnings == nil {
		warnings = []MoveWarning{}
	}
	return warnings
}
