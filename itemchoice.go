package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/jasonsoprovich/seekers-epgp-parser/internal/items"
	"github.com/jasonsoprovich/seekers-epgp-parser/internal/parse"
)

// Which item id a bid round is for. ~150 item names have more than one id
// that drops (quarm.db duplicates, e.g. two "Carved Bone Ring"s: Crusader
// Kezzal's in The Grey and Terris Thule's NO DROP one), and the log only
// ever has the name. When a round opens, the app reads the officer's log
// around the announcement (recent kills, current zone) and picks the id via
// internal/items.Resolve; the officer can override it from the variant
// picker on the Bids tab. The id rides along to the grats link, the live
// board and the submitted round, so the site links the same copy.

// ItemVariantView is one id of a name that has several, for the picker.
type ItemVariantView struct {
	ID    int      `json:"id"`
	Name  string   `json:"name"`
	Level int      `json:"level"`
	Zones []string `json:"zones"`
}

// ItemChoice is the round's item id and how it was picked. ItemID is 0 when
// the name isn't a known item. Variants is empty unless the name has more
// than one id.
type ItemChoice struct {
	ItemID int `json:"itemId"`
	// "only" | "kill" | "zone" | "level" (see internal/items), or "picked"
	// once the officer chose one by hand. "" when the name didn't match.
	Reason string `json:"reason"`
	// The log context couldn't separate the candidates; ItemID is only the
	// default among them. The Bids tab highlights the picker then.
	Ambiguous bool              `json:"ambiguous"`
	Variants  []ItemVariantView `json:"variants"`
	// The zone and kills the choice was based on, shown in the picker's hint.
	Zone   string   `json:"zone"`
	Killed []string `json:"killed"`
}

func emptyItemChoice() ItemChoice {
	return ItemChoice{Variants: []ItemVariantView{}, Killed: []string{}}
}

// resolveItemChoice picks the id for itemName from the log context at `at`.
func resolveItemChoice(raw, itemName string, at time.Time) ItemChoice {
	out := emptyItemChoice()
	ctx := parse.FindLootContext(raw, at)
	out.Zone, out.Killed = ctx.Zone, ctx.Killed
	r, ok := items.Resolve(itemName, items.Hint{Zone: ctx.Zone, Killed: ctx.Killed})
	if !ok {
		return out
	}
	out.ItemID, out.Reason, out.Ambiguous = r.Item.ID, r.Reason, r.Ambiguous
	for _, v := range r.Variants {
		out.Variants = append(out.Variants, ItemVariantView{ID: v.ID, Name: v.Name, Level: v.Level, Zones: v.Zones})
	}
	return out
}

// ResolveItem is resolveItemChoice for the Bids tab's manual round, where
// the officer types the item name: at is the round's time (RFC3339), or
// empty for now.
func (a *App) ResolveItem(itemName string, at string) ItemChoice {
	if strings.TrimSpace(itemName) == "" {
		return emptyItemChoice()
	}
	when := time.Now()
	if t, err := time.Parse(time.RFC3339, at); err == nil {
		when = t
	}
	raw, err := a.readLog()
	if err != nil {
		raw = ""
	}
	return resolveItemChoice(raw, itemName, when)
}

// SetBidRoundItem records the officer's pick from the variant picker. For
// the live round it updates what the poller pushes to the site (the next
// tick sends it); for a parked or reviewed round there's nothing to update
// here — the frontend holds that round and passes the id to SubmitBids.
func (a *App) SetBidRoundItem(roundID string, itemID int) error {
	a.liveBidsMu.Lock()
	defer a.liveBidsMu.Unlock()
	if roundID == "" || roundID != a.roundID {
		return nil
	}
	c := a.roundItemChoice
	for _, v := range c.Variants {
		if v.ID == itemID {
			c.ItemID, c.Reason, c.Ambiguous = itemID, "picked", false
			a.roundItemChoice = c
			return nil
		}
	}
	return fmt.Errorf("item %d is not a copy of %q", itemID, a.roundItem)
}

// ItemLink renders itemName as an in-game clickable item link (see
// internal/items.Link) for the Bids tab's grats message, so it pastes into
// guild/raid chat the same way a real linked item does instead of as plain
// text. itemID is the round's chosen copy (ItemChoice.ItemID); 0 falls back
// to the name lookup (items.Match — same typo-tolerant lookup the
// announcement watcher uses). The plain name comes back unchanged when
// neither finds the item — the officer still gets a usable grats line,
// just without the clickable link.
func (a *App) ItemLink(itemName string, itemID int) string {
	if itemID > 0 {
		if it, ok := items.ByID(itemID); ok {
			return items.Link(it)
		}
	}
	if it, ok := items.Match(itemName); ok {
		return items.Link(it)
	}
	return itemName
}
