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

		location, name, id, count, ok := parseLine(line)
		if !ok || name == "" || name == "Empty" {
			continue
		}

		switch classifySharedBank(location) {
		case sharedBankDead:
			continue // this server never populates slots 11-30 — not real data
		case sharedBankReal:
			exp.SharedBank = append(exp.SharedBank, toHolding(location, name, id, count))
		default:
			exp.Holdings = append(exp.Holdings, toHolding(location, name, id, count))
		}
	}

	return exp, scanner.Err()
}

// toHolding builds a Holding from one parsed row, classifying a "-Coin"
// location as currency (id is always 0 for these — coin isn't an item)
// and a "Spell: " name as a spell, else a plain item.
func toHolding(location, name string, id, count int) Holding {
	container, slotIndex := decomposeLocation(location)
	category := CategoryItem
	switch {
	case strings.HasSuffix(location, "-Coin"):
		category = CategoryCurrency
	case strings.HasPrefix(name, "Spell: "):
		category = CategorySpell
	}
	return Holding{
		Container: container,
		SlotIndex: slotIndex,
		Category:  category,
		ItemName:  name,
		ItemID:    id,
		Quantity:  count,
	}
}

// parseLine parses one tab-delimited inventory row:
// Location\tName\tID\tCount/Charges\tSlots (only the first four columns
// matter here — bag capacity isn't part of a bank_holdings row).
func parseLine(line string) (location, name string, id, count int, ok bool) {
	parts := strings.Split(line, "\t")
	if len(parts) < 4 {
		return "", "", 0, 0, false
	}

	itemID, err := strconv.Atoi(strings.TrimSpace(parts[2]))
	if err != nil {
		return "", "", 0, 0, false
	}

	c, _ := strconv.Atoi(strings.TrimSpace(parts[3]))

	return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1]), itemID, c, true
}
