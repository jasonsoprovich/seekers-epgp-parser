package items

import (
	"sort"
	"strings"
)

// quarm.db has ~900 names shared by several item ids, and about 150 of
// those names have more than one id that actually drops. The log never
// carries the id (item links are written out as plain text, see CLAUDE.md),
// so the bid flow has to work out which copy dropped: Lookup/Match alone
// return the default (highest drop level, then lowest id), which is wrong
// whenever the lower-level copy is the one on the corpse. Resolve narrows
// the candidates with what the officer's own log says about the moment the
// item was announced — the NPCs slain shortly before and the zone they're
// in — and only falls back to the default when those don't decide it.

// Variant is one id of a name that has several.
type Variant struct {
	ID    int
	Name  string
	Level int // highest dropping-NPC level, 0 = never drops (see gen-items.sh)
	// Zone long names the dropping NPCs spawn in, as "You have entered X."
	// prints them, and the NPCs' raw quarm.db names ("Terris_Thule").
	Zones []string
	NPCs  []string
}

// Hint is the log context around an item announcement.
type Hint struct {
	Zone   string   // the officer's current zone, as "You have entered X." printed it
	Killed []string // NPCs slain shortly before the announcement, most recent first
}

// How Resolve decided.
const (
	ReasonOnly  = "only"  // the name has a single id
	ReasonKill  = "kill"  // exactly one copy drops from a recently slain NPC
	ReasonZone  = "zone"  // exactly one copy drops in the officer's zone
	ReasonLevel = "level" // fell back to the highest drop level, then lowest id
)

// Resolution is Resolve's answer. Variants lists every id for the name (nil
// when there's only one), so a caller can offer a picker; Ambiguous means
// the log context left more than one candidate and Item is only the
// default among them.
type Resolution struct {
	Item      Item
	Variants  []Variant
	Reason    string
	Ambiguous bool
}

// Resolve finds the item named `name` (same lookup as Match) and picks which
// of its ids most likely dropped, given the log context.
func Resolve(name string, hint Hint) (Resolution, bool) {
	ensureLoaded()
	it, ok := matchIn(normalize(name), byNorm)
	if !ok {
		return Resolution{}, false
	}
	vs := variantsOf[normalize(it.Name)]
	if len(vs) < 2 {
		return Resolution{Item: it, Reason: ReasonOnly}, true
	}
	return resolveAmong(vs, hint), true
}

// resolveAmong is Resolve's algorithm over an arbitrary variant list, so
// tests can use synthetic data.
func resolveAmong(vs []Variant, hint Hint) Resolution {
	out := Resolution{Variants: sortedVariants(vs)}
	cands := out.Variants

	if len(hint.Killed) > 0 {
		// The most recent kill that drops any candidate decides it — the
		// item on the corpse being looted came from the latest such kill.
		for _, k := range hint.Killed {
			nk := normalizeNPC(k)
			var hit []Variant
			for _, v := range cands {
				for _, n := range v.NPCs {
					if normalizeNPC(n) == nk {
						hit = append(hit, v)
						break
					}
				}
			}
			if len(hit) == 1 {
				out.Item, out.Reason = itemOf(hit[0]), ReasonKill
				return out
			}
			if len(hit) > 1 {
				cands = hit
				break
			}
		}
	}

	if z := normalizeZone(hint.Zone); z != "" {
		var hit []Variant
		for _, v := range cands {
			for _, vz := range v.Zones {
				if normalizeZone(vz) == z {
					hit = append(hit, v)
					break
				}
			}
		}
		if len(hit) == 1 {
			out.Item, out.Reason = itemOf(hit[0]), ReasonZone
			return out
		}
		if len(hit) > 1 {
			cands = hit
		}
	}

	best := cands[0]
	for _, v := range cands[1:] {
		if v.Level > best.Level || (v.Level == best.Level && v.ID < best.ID) {
			best = v
		}
	}
	out.Item, out.Reason, out.Ambiguous = itemOf(best), ReasonLevel, len(cands) > 1
	return out
}

// ByID returns the item with this id.
func ByID(id int) (Item, bool) {
	ensureLoaded()
	it, ok := byID[id]
	return it, ok
}

func itemOf(v Variant) Item { return Item{ID: v.ID, Name: v.Name} }

// sortedVariants orders a picker the way the default tiebreak ranks them:
// highest drop level first, then lowest id.
func sortedVariants(vs []Variant) []Variant {
	out := append([]Variant(nil), vs...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Level != out[j].Level {
			return out[i].Level > out[j].Level
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// normalizeNPC folds a quarm.db NPC name ("#Avatar_of_Earth",
// "a_lightcrawler01") and a log one ("Avatar of Earth") to the same key.
func normalizeNPC(s string) string {
	s = strings.TrimLeft(strings.TrimSpace(s), "#")
	s = strings.ReplaceAll(s, "_", " ")
	s = strings.TrimRight(s, "0123456789 ")
	return normalize(s)
}

// normalizeZone folds "Plane of Fear (Instanced)" to "plane of fear" and
// drops a leading "The " so either spelling of a zone matches.
func normalizeZone(s string) string {
	s = normalize(s)
	if i := strings.LastIndex(s, " ("); i > 0 && strings.HasSuffix(s, ")") {
		s = s[:i]
	}
	return strings.TrimPrefix(s, "the ")
}
