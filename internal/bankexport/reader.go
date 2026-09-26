package bankexport

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// fileNameRe matches a Zeal inventory export in either format — the
// legacy "<CharName>-Inventory.txt" or the "_pq.proj" variant Zeal's
// /outputfile toggle also produces — and captures the character name.
// Ported from pq-companion's scanner.go (inventoryFileRe).
var fileNameRe = regexp.MustCompile(`(?i)^(.+?)-Inventory(?:_pq\.proj)?\.txt$`)

// CharacterFromFileName extracts the character name from a Zeal
// inventory export's file name, or "" if it doesn't match either known
// format. This is only ever a default/suggestion — the officer app must
// still let the officer confirm which roster character an import
// actually belongs to, the same way NoMatchSelect never trusts a
// captured log name blindly.
func CharacterFromFileName(path string) string {
	m := fileNameRe.FindStringSubmatch(filepath.Base(path))
	if m == nil {
		return ""
	}
	return m[1]
}

// ParseExport reads and parses a Zeal inventory export file.
// Format: tab-delimited, header row "Location\tName\tID\tCount/Charges\t
// Slots" (ported from pq-companion's reader.go — ParseInventory/
// parseInventoryLine). "Empty" rows (unoccupied slots) are dropped: this
// package builds bank_holdings rows, not a full slot-grid for UI
// rendering, so there's nothing useful an empty-slot row would represent
// here. Equipment-slot aliasing (Ear1/Ear2 -> "Ear", pq-companion's
// canonicalSlot) is deliberately NOT ported — that's a display concern
// for rendering worn gear, irrelevant to bag/bank inventory content.
func ParseExport(path string) (*Export, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	exp := &Export{
		Character:  CharacterFromFileName(path),
		Holdings:   []Holding{},
		SharedBank: []Holding{},
	}
	if info, err := f.Stat(); err == nil {
		exp.ExportedAt = info.ModTime()
	}

	scanner := bufio.NewScanner(f)
	firstLine := true
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}

		if firstLine {
			firstLine = false
			parts := strings.SplitN(line, "\t", 2)
			if len(parts) > 0 && strings.EqualFold(strings.TrimSpace(parts[0]), "location") {
				continue // header row
			}
		}

		location, name, id, count, bagSlots, ok := parseLine(line)
		if !ok || name == "" || name == "Empty" {
			continue
		}

		switch classifySharedBank(location) {
		case sharedBankDead:
			continue // this server never populates slots 11-30 — not real data
		case sharedBankReal:
			exp.SharedBank = append(exp.SharedBank, toHolding(location, name, id, count, bagSlots))
		default:
			exp.Holdings = append(exp.Holdings, toHolding(location, name, id, count, bagSlots))
		}
	}

	return exp, scanner.Err()
}

// toHolding builds a Holding from one parsed row, classifying a "-Coin"
// location as currency (id is always 0 for these — coin isn't an item)
// and a "Spell: " name as a spell, else a plain item.
func toHolding(location, name string, id, count, bagSlots int) Holding {
	container, slotIndex := decomposeLocation(location)
	category := CategoryItem
	switch {
	case strings.HasSuffix(location, "-Coin"):
		category = CategoryCurrency
	case strings.HasPrefix(name, "Spell: "):
		category = CategorySpell
	}
	// Zeal writes 0 in the Count/Charges column for some real, single,
	// non-stacking items — e.g. "Forge of Icewell Arms" (a tradeskill
	// object, not a charge-based clicky) — not just for a genuinely empty
	// slot (those come through as name "Empty" and are already dropped
	// before this is called). Ported from pq-companion's reader.go, which
	// coerces the same way — a real item's quantity is never actually
	// zero; the server also rejects a zero/negative quantity outright, so
	// this has to be fixed at parse time, not left for BuildSyncRows to
	// silently mis-sync or the server to reject the whole payload.
	// Currency is exempt: General-Coin/Bank-Coin legitimately reads 0 when
	// a character is simply carrying/banking no coin.
	if count == 0 && category != CategoryCurrency {
		count = 1
	}
	return Holding{
		Container: container,
		SlotIndex: slotIndex,
		Category:  category,
		ItemName:  name,
		ItemID:    id,
		Quantity:  count,
		BagSlots:  bagSlots,
	}
}

// parseLine parses one tab-delimited inventory row:
// Location\tName\tID\tCount/Charges\tSlots. bagSlots (column 5, the bag's
// own capacity) is optional — a row with only 4 columns still parses,
// bagSlots just comes back 0 (indistinguishable from "not a bag", which is
// the same thing a genuinely non-bag row means).
func parseLine(line string) (location, name string, id, count, bagSlots int, ok bool) {
	parts := strings.Split(line, "\t")
	if len(parts) < 4 {
		return "", "", 0, 0, 0, false
	}

	itemID, err := strconv.Atoi(strings.TrimSpace(parts[2]))
	if err != nil {
		return "", "", 0, 0, 0, false
	}

	c, _ := strconv.Atoi(strings.TrimSpace(parts[3]))
	var slots int
	if len(parts) >= 5 {
		slots, _ = strconv.Atoi(strings.TrimSpace(parts[4]))
	}

	return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1]), itemID, c, slots, true
}
