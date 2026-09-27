package bankexport

import "strings"

// UnverifiedItem is one sheet/manual item still sitting on this holder,
// unconfirmed by any real sync yet — mirrors officerapi.UnverifiedItem
// without importing that package (same package-boundary reasoning as
// DesignatedSlot above: this package stays free of any tracker-API
// dependency).
type UnverifiedItem struct {
	ItemName string
	ItemID   int
	Quantity int
	// LegacyLocation is the item's original sheet position ("Bank3-Slot2"),
	// or "" for a manual row / a sheet row with no recognizable location.
	LegacyLocation string
	// Kind is "sheet" or "manual" — display-only, doesn't affect matching.
	Kind string
	// NotFound is true once a real sync of this holder already failed to
	// match it (src/lib/bank/sync.ts's reconcileUnverified) — the item
	// most worth calling out, since it's already known to need review.
	NotFound bool
}

// FlagSuggestion is one unflagged container this scan shows holding an
// item (or items) the sheet/manual data still lists as unverified for
// this holder — the officer app's "this bag holds sheet items — flag it?"
// callout, 2026-09-27, built before a sync rather than after: catching
// this here means fewer items land in the site's "needs review" list in
// the first place.
type FlagSuggestion struct {
	Container string
	Matches   []UnverifiedItem
}

// SuggestFlags finds unflagged top-level containers whose CURRENT
// contents look like they hold one of this holder's still-unverified
// items — name match only (the old sheet import never captured an item
// ID), with a container matching the item's own LegacyLocation counted no
// differently than any other name match (this is a suggestion, not a
// guarantee — the strength distinction that matters, exact-location vs.
// name-only, lives server-side in reconcileUnverified, which runs after a
// real sync and can partially consume a quantity; this is just "worth a
// look before you sync"). A container already flagged (present in
// `designated`) is skipped — nothing to suggest there. Personal
// containers are never matched against an item whose own recorded
// location was a SharedBank slot, and vice versa — a bag never crosses
// that boundary, same reasoning DetectMoves already uses.
//
// Best-effort/local only, same as DetectMoves: the site's own
// reconcileUnverified is the real authority once a sync actually runs.
func SuggestFlags(inv *Inventory, designated []DesignatedSlot, unverified []UnverifiedItem) []FlagSuggestion {
	if inv == nil || len(unverified) == 0 {
		return []FlagSuggestion{}
	}

	designatedContainers := map[string]bool{}
	for _, d := range designated {
		designatedContainers[d.Container] = true
	}

	order := []string{}
	byContainer := map[string]*FlagSuggestion{}

	for _, c := range allContainers(inv) {
		if designatedContainers[c.Container] {
			continue
		}
		shared := isSharedContainerName(c.Container)
		names := containerItemNames(c)
		if len(names) == 0 {
			continue
		}

		for _, u := range unverified {
			if u.LegacyLocation != "" && isSharedContainerName(u.LegacyLocation) != shared {
				continue
			}
			if !containsFold(names, u.ItemName) {
				continue
			}
			s := byContainer[c.Container]
			if s == nil {
				s = &FlagSuggestion{Container: c.Container}
				byContainer[c.Container] = s
				order = append(order, c.Container)
			}
			s.Matches = append(s.Matches, u)
		}
	}

	out := make([]FlagSuggestion, 0, len(order))
	for _, name := range order {
		out = append(out, *byContainer[name])
	}
	return out
}

// containerItemNames returns the names of every item actually held in a
// container — for a real bag, its contents; for a Loose top-level slot,
// the one item sitting there (buildContainers/inventory.go stores it as
// Items[0] either way, so no Loose special-case is needed here).
func containerItemNames(c Container) []string {
	names := make([]string, 0, len(c.Items))
	for _, it := range c.Items {
		names = append(names, it.ItemName)
	}
	return names
}

func containsFold(names []string, target string) bool {
	for _, n := range names {
		if strings.EqualFold(n, target) {
			return true
		}
	}
	return false
}
