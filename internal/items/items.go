// Package items is an embedded, in-memory index of every Quarm item name
// (including Planes of Power — there's no expansion filter, see
// scripts/gen-items.sh), built into the binary with go:embed so the app
// stays a single portable executable with no side files or extra Go
// modules.
//
// It backs two things:
//   - The announcement-detection gate (see app.go's startAnnouncementWatch):
//     telling an officer's real "<item> send tells" apart from an
//     unrelated "SS/SP send tells" buff request, which the old
//     Capitalized-words-only structural check couldn't do.
//   - The in-game clickable item link on the grats message (Link), which
//     needs the item's numeric ID — nothing else in the bid flow has one.
package items

import (
	"bufio"
	"bytes"
	"compress/gzip"
	_ "embed"
	"fmt"
	"strconv"
	"strings"
	"sync"
)

//go:embed items.tsv.gz
var itemsGz []byte

// Item is one Quarm item: the items.id row (needed for an in-game link)
// and its canonical display name.
type Item struct {
	ID   int
	Name string
}

var (
	loadOnce sync.Once
	byNorm   map[string]Item
	loadErr  error
)

// normalize collapses whitespace, lowercases, and treats a backtick the
// same as an apostrophe. quarm.db mixes both for the same character —
// e.g. "Song: Denon`s Dissension" uses a backtick, "Denon's Drums of
// Declivity" uses an apostrophe — and officers only ever type the
// apostrophe.
func normalize(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, "`", "'")
	s = strings.ReplaceAll(s, "‘", "'") // curly single quotes, just in case
	s = strings.ReplaceAll(s, "’", "'")
	return strings.Join(strings.Fields(s), " ")
}

// load parses the embedded id\tName\tdroppable TSV into byNorm, resolving
// the ~900 names that map to more than one item ID: prefer one that
// actually drops from a loot table (droppable) over a merchant-only or
// quest-reward duplicate with the same display name, and fall back to the
// lowest ID as a stable tiebreak.
func load() {
	byNorm = make(map[string]Item, 26000)
	droppableOf := make(map[string]bool, 26000)

	gr, err := gzip.NewReader(bytes.NewReader(itemsGz))
	if err != nil {
		loadErr = fmt.Errorf("items: opening embedded data: %w", err)
		return
	}
	defer gr.Close()

	sc := bufio.NewScanner(gr)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) != 3 {
			continue
		}
		id, err := strconv.Atoi(parts[0])
		if err != nil {
			continue
		}
		name := parts[1]
		norm := normalize(name)
		if norm == "" {
			continue
		}
		droppable := parts[2] == "1"

		existing, seen := byNorm[norm]
		switch {
		case !seen:
			byNorm[norm] = Item{ID: id, Name: name}
			droppableOf[norm] = droppable
		case droppable && !droppableOf[norm]:
			byNorm[norm] = Item{ID: id, Name: name}
			droppableOf[norm] = true
		case droppable == droppableOf[norm] && id < existing.ID:
			byNorm[norm] = Item{ID: id, Name: name}
		}
	}
	if err := sc.Err(); err != nil {
		loadErr = fmt.Errorf("items: reading embedded data: %w", err)
	}
}

func ensureLoaded() {
	loadOnce.Do(load)
}

// Ready reports whether the embedded item index loaded. A caller that gets
// false back should fall back to a different check — Lookup/Match always
// report "not found" once loadErr is set, which would otherwise silently
// look like every name failed to match.
func Ready() bool {
	ensureLoaded()
	return loadErr == nil
}

// Lookup finds an item by exact name (case- and punctuation-insensitive —
// see normalize). No typo tolerance.
func Lookup(name string) (Item, bool) {
	ensureLoaded()
	it, ok := byNorm[normalize(name)]
	return it, ok
}

// Short candidates never get typo tolerance — a 1-edit distance on a 3-4
// character string ("KEI", "SoW") matches almost anything, which is
// exactly the false-positive this package exists to prevent.
const (
	minFuzzyLen      = 8
	extendedFuzzyLen = 16
)

// Match finds an item by exact name, or — for names long enough that a
// small edit distance is actually meaningful — the closest item within 1
// edit (8-15 chars) or 2 edits (16+ chars). It refuses to guess when two
// different items are equally close, rather than picking one arbitrarily.
func Match(name string) (Item, bool) {
	ensureLoaded()
	return matchIn(normalize(name), byNorm)
}

// matchIn holds Match's actual algorithm over an arbitrary candidate map,
// so tests can exercise it (in particular the ambiguous-tie rejection)
// against a small synthetic map instead of depending on the real ~25,000
// row DB happening to contain a reproducible tie.
func matchIn(norm string, candidates map[string]Item) (Item, bool) {
	if it, ok := candidates[norm]; ok {
		return it, true
	}
	if len(norm) < minFuzzyLen {
		return Item{}, false
	}
	maxDist := 1
	if len(norm) >= extendedFuzzyLen {
		maxDist = 2
	}

	bestDist := maxDist + 1
	var best Item
	ambiguous := false
	for cand, it := range candidates {
		// Length prefilter: an edit distance of at most maxDist can't
		// bridge a length gap bigger than maxDist. Skips the vast
		// majority of the ~25,000 names before the O(len*len)
		// Levenshtein call below.
		if diff := len(cand) - len(norm); diff > maxDist || diff < -maxDist {
			continue
		}
		d := levenshtein(norm, cand, bestDist)
		switch {
		case d < bestDist:
			bestDist, best, ambiguous = d, it, false
		case d == bestDist && d <= maxDist && it.ID != best.ID:
			ambiguous = true
		}
	}
	if ambiguous || bestDist > maxDist {
		return Item{}, false
	}
	return best, true
}

// Link renders it as an in-game clickable item link: the classic Mac-era
// EQMacEmu/Project Quarm format — DC2 (0x12) control byte, item ID
// zero-padded to 6 decimal digits, a space, the name, closing DC2. This
// matches pq-companion's frontend/src/lib/itemHelpers.ts, confirmed
// working in-game there; EQ strips the DC2 bytes and renders the name as
// a clickable link.
func Link(it Item) string {
	return fmt.Sprintf("\x12%06d %s\x12", it.ID, it.Name)
}

// levenshtein computes edit distance between a and b, but bails out early
// once a row's minimum already exceeds max — returning max+1 rather than
// the true (larger) distance, which is all Match needs to reject a
// candidate. a/b are compared rune-wise, not byte-wise, since item names
// can contain multi-byte punctuation.
func levenshtein(a, b string, max int) int {
	ar, br := []rune(a), []rune(b)
	if len(ar) < len(br) {
		ar, br = br, ar
	}
	prev := make([]int, len(br)+1)
	for j := range prev {
		prev[j] = j
	}
	cur := make([]int, len(br)+1)
	for i := 1; i <= len(ar); i++ {
		cur[0] = i
		rowMin := cur[0]
		for j := 1; j <= len(br); j++ {
			cost := 1
			if ar[i-1] == br[j-1] {
				cost = 0
			}
			v := prev[j] + 1 // deletion
			if ins := cur[j-1] + 1; ins < v {
				v = ins // insertion
			}
			if sub := prev[j-1] + cost; sub < v {
				v = sub // substitution
			}
			cur[j] = v
			if v < rowMin {
				rowMin = v
			}
		}
		if rowMin > max {
			return max + 1
		}
		prev, cur = cur, prev
	}
	return prev[len(br)]
}
