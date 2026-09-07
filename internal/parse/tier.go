package parse

import (
	"sort"
	"strings"
)

// Canonical GP bid tiers — must match the activity names already seeded in
// the site's epgp_point_values table (High Bid=100, Medium Bid=50, Low
// Bid=10, Alt Loot=10, Rot (No-Drop)=10).
const (
	TierHigh = "High Bid"
	TierMed  = "Medium Bid"
	TierLow  = "Low Bid"
	TierAlt  = "Alt Loot"
	TierRot  = "Rot (No-Drop)"
)

// BidSignal is what DetectBidSignal found in one tell's message text.
// Tier == "" && !Cancel means no recognizable bid signal at all (ordinary
// chat, not shown to the officer). Ambiguous == true means a signal WAS
// found but couldn't be resolved to one tier — shown to the officer for a
// manual pick, never auto-resolved. Cancel == true means the bidder asked
// to pull their bid ("cancel my bid") — the officer's existing capture for
// that character is flagged for review, not silently dropped.
type BidSignal struct {
	Tier       string
	Ambiguous  bool
	Cancel     bool
	RawMessage string
}

// tokenize splits a tell's message on whitespace and hyphens (real bids
// arrive hyphen-glued to the item name, e.g. "High-Soul Essence of Aten Ha
// Ra"), lowercases, and strips surrounding punctuation.
func tokenize(msg string) []string {
	fields := strings.FieldsFunc(msg, func(r rune) bool {
		switch r {
		case '-', ',', ' ', '\t':
			return true
		default:
			return false
		}
	})
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		f = strings.ToLower(strings.Trim(f, ".:!?'\""))
		if f != "" {
			out = append(out, f)
		}
	}
	return out
}

// DetectBidSignal looks for a bid tier anywhere in a tell's message —
// officers' actual messages mix the tier with the item name in either
// order, extra commentary, ALL CAPS, and numeric GP amounts instead of
// words (confirmed against real bid-log samples, not guessed). Common real
// phrasings this handles: "main high", "change to low", "pretty pretty
// princess high", "slight"/"major", "100"/"50"/"10".
//
// "10" resolves to Low Bid. It costs the same as Alt Loot and Rot
// (No-Drop), but a bare number is overwhelmingly a normal main bid — an
// alt or rot claim is called out with the WORD ("alt", "rot"), and when
// that word is present alongside "10" the word wins. timeUnitWords right
// after a bare "10" mean it's a duration ("back in 10 minutes"), not a GP
// amount — a real false positive from bid-log samples ("a meeting starting
// in 10 minutes").
var timeUnitWords = map[string]bool{
	"minute": true, "minutes": true, "min": true, "mins": true,
	"second": true, "seconds": true, "sec": true, "secs": true,
	"hour": true, "hours": true, "hr": true, "hrs": true,
}

// cancelWords: a tell containing one of these, with no tier word alongside,
// is a bid retraction — flag the bidder's captured row for the officer to
// judge, don't auto-remove it (they may have re-bid after, or be joking).
var cancelWords = map[string]bool{
	"cancel": true, "retract": true, "withdraw": true, "unbid": true,
}

func DetectBidSignal(msg string) BidSignal {
	tokens := tokenize(msg)

	found := map[string]bool{}
	bareTen := false
	sawCancel := false

	for i, t := range tokens {
		switch t {
		case "high", "hi", "major":
			found[TierHigh] = true
		case "medium", "med", "mid", "slight":
			found[TierMed] = true
		case "low", "lo", "minor", "small":
			found[TierLow] = true
		case "alt":
			found[TierAlt] = true
		case "rot":
			found[TierRot] = true
		case "100":
			found[TierHigh] = true
		case "50":
			found[TierMed] = true
		case "10":
			if i+1 < len(tokens) && timeUnitWords[tokens[i+1]] {
				continue
			}
			bareTen = true
		default:
			if cancelWords[t] {
				sawCancel = true
			}
		}
	}

	// "cancel my bid" with no tier alongside — a retraction, not a bid.
	// (If they said "cancel, actually low" both are set and it falls through
	// to the normal tier resolution below, flagged ambiguous for review.)
	if sawCancel && len(found) == 0 && !bareTen {
		return BidSignal{Cancel: true, RawMessage: msg}
	}

	if bareTen && !found[TierAlt] && !found[TierRot] {
		// A bare "10" is a Low Bid. "10 alt" / "10 rot" keep the word's
		// specific claim instead — the digits and the word agree there.
		found[TierLow] = true
	}

	switch len(found) {
	case 0:
		return BidSignal{Cancel: sawCancel, RawMessage: msg}
	case 1:
		for tier := range found {
			return BidSignal{Tier: tier, Ambiguous: sawCancel, RawMessage: msg}
		}
	}

	tiers := make([]string, 0, len(found))
	for tier := range found {
		tiers = append(tiers, tier)
	}
	sort.Strings(tiers)
	return BidSignal{Tier: strings.Join(tiers, " / "), Ambiguous: true, RawMessage: msg}
}
