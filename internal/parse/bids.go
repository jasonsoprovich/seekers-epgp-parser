package parse

import (
	"regexp"
	"strings"
	"time"
	"unicode"
)

var tellRe = regexp.MustCompile(`^(\S+) tells you, '(.*)'$`)

// A log owner's own outgoing chat always starts with "You " (say/tell/
// tells to guild/raid/party/etc.) followed by a quoted message — never
// another character's name, so this can't false-match someone else
// announcing a different item. See FindAnnouncementStart.
var ownChatRe = regexp.MustCompile(`^You .*, '(.*)'$`)

// announceTriggerRe matches the phrases officers actually use to open a bid
// round, tolerant of whitespace, hyphens, and case. Real variants seen in
// the field: "<item> send tells", "<item> - send tells", "send tells <item>",
// "<item> start bids", "<item> starting bids", "bids open <item>". Splitting
// a message on this lets extractItemName take whichever side holds the name.
var announceTriggerRe = regexp.MustCompile(`(?i)\b(?:sends?[\s-]+tells?|start(?:ing)?[\s-]+bids?|bids?[\s-]+open|open[\s-]+bids?)\b`)

// itemLinkRe matches an EQ client item link: the visible name wrapped in
// DC2 (0x12) control bytes with a run of fixed-width numeric header fields
// in front of it. stripItemLinks pulls the name back out — officers often
// paste the clickable link into a "last call", and the raw header digits
// would otherwise wreck the item-name match.
var itemLinkRe = regexp.MustCompile("\x12([^\x12]*)\x12")

// stripItemLinks replaces every 0x12-delimited item link in msg with just
// its visible name. The emu link header is fixed-width decimal fields, so
// the name is the payload's trailing stretch containing no digits.
func stripItemLinks(msg string) string {
	if !strings.ContainsRune(msg, '\x12') {
		return msg
	}
	return itemLinkRe.ReplaceAllStringFunc(msg, func(m string) string {
		inner := strings.Trim(m, "\x12")
		last := -1
		for i, r := range inner {
			if r >= '0' && r <= '9' {
				last = i
			}
		}
		if last >= 0 && last+1 < len(inner) {
			inner = inner[last+1:]
		}
		return strings.TrimSpace(inner)
	})
}

// itemNameConnectors are the only lowercase words allowed to appear
// mid-name — EQ item names are otherwise a run of Capitalized words
// ("Cloak of Flames", "Robe of the Kedge Knight", "Soul Essence of Aten Ha
// Ra"). Anything else lowercase means it's prose, not an item.
var itemNameConnectors = map[string]bool{
	"of": true, "the": true, "a": true, "an": true, "and": true, "to": true, "with": true, "de": true,
}

// looksLikeItemName is a deterministic sanity check on a candidate pulled
// out of free chat. It rejects the failure mode from the first live test
// (an officer typing "send tells" inside a sentence — "last call, it reset
// the bids on mine cause it saw send tells" — which extractItemName would
// otherwise hand back as an "item name" and auto-start a junk round,
// wiping the real one). A real name is a short run of Capitalized words
// plus connectors; prose has lowercase non-connector words and/or
// sentence punctuation.
func looksLikeItemName(cand string) bool {
	cand = strings.TrimSpace(cand)
	if len(cand) < 3 || len(cand) > 64 {
		return false
	}
	if strings.ContainsAny(cand, ",;:!?\"") {
		return false
	}
	fields := strings.Fields(cand)
	if len(fields) == 0 || len(fields) > 8 {
		return false
	}
	for _, w := range fields {
		if itemNameConnectors[strings.ToLower(w)] {
			continue
		}
		r := []rune(w)
		// Capitalized ("Cloak"), a bare number or roman-ish token ("Type 3",
		// "Mark II"), or an all-caps abbreviation — all fine. A lowercase
		// word that isn't a connector is prose.
		if unicode.IsUpper(r[0]) || unicode.IsDigit(r[0]) {
			continue
		}
		return false
	}
	return true
}

// isPlausibleItem gates a candidate from DetectAnnouncement: accept it if
// it exactly matches (case-insensitively) an item the guild has looted
// before, or if it structurally looks like an EQ item name. `known` is the
// site's distinct gp_ledger.item_name list (may be nil — the structural
// check still applies).
func isPlausibleItem(name string, known []string) bool {
	if name == "" {
		return false
	}
	n := strings.ToLower(strings.TrimSpace(name))
	for _, k := range known {
		if strings.ToLower(strings.TrimSpace(k)) == n {
			return true
		}
	}
	return looksLikeItemName(name)
}

// extractItemName pulls a probable item name out of an officer's own
// "send tells" announcement. Officers phrase it a few ways —
//
//	"Soul Essence of Aten Ha Ra send tells"
//	"send tells for Soul Essence of Aten Ha Ra"
//	"Soul Essence of Aten Ha Ra - send tells now"
//	"Soul Essence of Aten Ha Ra send tells - last call"
//
// — so split on "send tells", take the longer side (the item name is
// almost always the bulk of the line), and trim only LEADING/TRAILING
// connectors and punctuation — never interior words, since an item name
// legitimately contains "of"/"the"/"the Kedge". It's free chat, so this is
// best-effort: the app shows the result in an editable field and the
// officer corrects it if it came out wrong.
func extractItemName(msg string) string {
	parts := announceTriggerRe.Split(stripItemLinks(msg), 2)
	cand := strings.TrimSpace(parts[0])
	if len(parts) == 2 {
		after := strings.TrimSpace(parts[1])
		if len(after) > len(cand) {
			cand = after
		}
	}

	trimSet := " \t-:,.!?\"'"
	cand = strings.Trim(cand, trimSet)
	lower := strings.ToLower(cand)
	for _, lead := range []string{"for ", "on ", "to ", "item ", "the item "} {
		if strings.HasPrefix(lower, lead) {
			cand = cand[len(lead):]
			lower = strings.ToLower(cand)
		}
	}
	// Strip trailing "last call" / "final call" / politeness noise. Looped
	// until stable so "…last call please" reduces past both, and covers the
	// hyphen/no-hyphen and singular/plural variants officers actually type.
	trailers := []string{
		"last call", "final call", "last calls", "lastcall", "last-call", "final-call",
		"lc", "reminder", "now", "asap", "please", "pls", "plz", "thanks", "thx", "ty",
	}
	for {
		stripped := false
		for _, trail := range trailers {
			if lower == trail || strings.HasSuffix(lower, " "+trail) || strings.HasSuffix(lower, "-"+trail) {
				cut := len(cand) - len(trail)
				if cut > 0 {
					cut-- // drop the separating space/hyphen too
				}
				cand = strings.Trim(cand[:cut], trimSet)
				lower = strings.ToLower(cand)
				stripped = true
			}
		}
		if !stripped || cand == "" {
			break
		}
	}
	cand = strings.Trim(cand, trimSet)
	return strings.Join(strings.Fields(cand), " ")
}

// DetectAnnouncement returns the item name and timestamp of the log
// owner's OWN most recent bid-round announcement strictly after `since` and
// at or before `cutoff` — a "You ..., '<msg>'" line whose message carries a
// trigger phrase (announceTriggerRe: "send tells", "start bids", …) AND
// whose extracted name passes isPlausibleItem. ok is false if there's no
// such new line.
//
// The isPlausibleItem gate is what stops a "send tells" typed inside an
// ordinary sentence from auto-starting a junk round (first live test: a
// prose line wiped a live round because extractItemName returned the
// surrounding words as an "item name"). `known` is the site's distinct
// gp_ledger.item_name list — pass nil and only the structural check
// applies.
//
// It only ever looks at the officer's own outgoing chat (ownChatRe), so a
// *different* officer announcing a *different* item in the same channel
// never triggers it — same guarantee CaptureBids relies on.
func DetectAnnouncement(raw string, since, cutoff time.Time, known []string) (itemName string, at time.Time, ok bool) {
	for _, l := range splitLogLines(raw) {
		if !l.Time.After(since) || l.Time.After(cutoff) {
			continue
		}
		m := ownChatRe.FindStringSubmatch(l.Text)
		if m == nil {
			continue
		}
		if !announceTriggerRe.MatchString(m[1]) {
			continue
		}
		name := extractItemName(m[1])
		if !isPlausibleItem(name, known) {
			continue
		}
		// Keep scanning — the newest matching line wins, not the first.
		itemName, at, ok = name, l.Time, true
	}
	return
}

// How far apart two "send tells" announcements for the same item can be
// and still count as one bidding round (the opening call and a later
// "- last call" reminder — 2.5 minutes apart in the real sample) rather
// than two separate rounds (the same item name dropping again later in
// the raid). A reminder must NOT reset the window: bids already collected
// between the opening call and the reminder are still real bids.
const announcementSessionGap = 10 * time.Minute

// FindAnnouncementStart returns the timestamp of the EARLIEST line in the
// most recent unbroken run of "send tells" announcements for this item at
// or before cutoff — a "You ..., '<message>'" line whose message contains
// both "send tells" and the item name, case-insensitively. A "- last
// call" repeat within announcementSessionGap of the previous one extends
// the window backward to the opening call instead of restarting it; a gap
// larger than that starts a fresh run (a later, unrelated drop of the
// same item name). ok is false if no such line exists at all, meaning the
// officer hasn't said "send tells" for this item yet, or the item name
// doesn't match what they typed.
func FindAnnouncementStart(raw string, itemName string, cutoff time.Time) (foundAt time.Time, ok bool) {
	item := strings.ToLower(strings.TrimSpace(itemName))
	if item == "" {
		return time.Time{}, false
	}

	var times []time.Time
	for _, l := range splitLogLines(raw) {
		if l.Time.After(cutoff) {
			break
		}
		m := ownChatRe.FindStringSubmatch(l.Text)
		if m == nil {
			continue
		}
		msg := stripItemLinks(m[1])
		if announceTriggerRe.MatchString(msg) && strings.Contains(strings.ToLower(msg), item) {
			times = append(times, l.Time)
		}
	}
	if len(times) == 0 {
		return time.Time{}, false
	}

	start := times[len(times)-1]
	for i := len(times) - 2; i >= 0; i-- {
		if start.Sub(times[i]) > announcementSessionGap {
			break
		}
		start = times[i]
	}
	return start, true
}

// BidCandidate is one incoming tell that looked like a bid during a
// capture window. Item name isn't recorded here — the officer names the
// item once when they click Start, not per-tell — see CaptureBids.
type BidCandidate struct {
	CharacterName string
	OccurredAt    time.Time
	Tier          string
	Ambiguous     bool
	RawMessage    string
	// The tell was "cancel my bid" (no tier). buildRows uses it to flag the
	// bidder's earlier row for review rather than emitting a row of its own.
	Cancel bool
}

// CaptureBids scans raw log text for tells addressed to the log's owner
// between startAt and stopAt (inclusive) and extracts bid candidates.
//
// This is deliberately a manual Start/Stop window rather than an
// auto-detected "send tells" trigger: a real bid session (see
// bids_sample.txt) can have a *different* officer announcing a *different*
// item concurrently in the same raw chat — but /tell only reaches its
// recipient, so a given officer's own log only ever shows tells meant for
// them. One officer never has two bid collections active in their own log
// at once, which is exactly what makes a manual window safe and
// unambiguous instead of needing to disambiguate overlapping items.
func CaptureBids(raw string, startAt, stopAt time.Time) []BidCandidate {
	lines := splitLogLines(raw)

	var out []BidCandidate
	for _, l := range lines {
		if l.Time.Before(startAt) || l.Time.After(stopAt) {
			continue
		}
		m := tellRe.FindStringSubmatch(l.Text)
		if m == nil {
			continue
		}
		signal := DetectBidSignal(m[2])
		if signal.Tier == "" && !signal.Cancel {
			continue
		}
		out = append(out, BidCandidate{
			CharacterName: m[1],
			OccurredAt:    l.Time,
			Tier:          signal.Tier,
			Ambiguous:     signal.Ambiguous,
			RawMessage:    m[2],
			Cancel:        signal.Cancel,
		})
	}
	return out
}

// ResolveLatestPerCharacter picks the last bid per character (by log
// order) as the default winner-eligible bid — a later tell from the same
// person means "changed my mind," matching how a live bid session
// actually works. Every candidate (including superseded ones) still comes
// from CaptureBids for the officer's review grid; this is just the
// starting default they can override before submitting.
func ResolveLatestPerCharacter(candidates []BidCandidate) map[string]BidCandidate {
	latest := make(map[string]BidCandidate, len(candidates))
	for _, c := range candidates {
		latest[strings.ToLower(c.CharacterName)] = c
	}
	return latest
}
