package parse

import (
	"sort"
	"strings"
)

// Canonical GP bid tiers — must match the activity names already seeded in
// the site's epgp_point_values table (High Bid=100, Medium Bid=50, Low
// Bid=10, Alt Loot=10).
const (
	TierHigh = "High Bid"
	TierMed  = "Medium Bid"
	TierLow  = "Low Bid"
	TierAlt  = "Alt Loot"
)

// BidSignal is what DetectBidSignal found in one tell's message text.
// Tier == "" means no recognizable bid signal at all (ordinary chat, not
// shown to the officer). Ambiguous == true means a signal WAS found but
// couldn't be resolved to one tier — shown to the officer for a manual
// pick, never auto-resolved.
type BidSignal struct {
	Tier       string
	Ambiguous  bool
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
// words (confirmed against real bid-log samples, not guessed).
//
// "10" is deliberately never auto-resolved: Low Bid and Alt Loot are both
// priced at 10 in epgp_point_values, so a bare "10" is genuinely
// ambiguous between them without the word "alt" alongside it — that's a
// judgment call for the officer, not something to silently guess.
// timeUnitWords immediately after a bare "10" mean it's a duration ("back
// in 10 minutes"), not a GP amount — confirmed against a real false
// positive in bid-log samples ("I have a zoom board meeting starting in 10
// minutes"), not a hypothetical.
var timeUnitWords = map[string]bool{
	"minute": true, "minutes": true, "min": true, "mins": true,
	"second": true, "seconds": true, "sec": true, "secs": true,
	"hour": true, "hours": true, "hr": true, "hrs": true,
}

func DetectBidSignal(msg string) BidSignal {
	tokens := tokenize(msg)

	found := map[string]bool{}
	bareTen := false

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
		case "100":
			found[TierHigh] = true
		case "50":
			found[TierMed] = true
		case "10":
			if i+1 < len(tokens) && timeUnitWords[tokens[i+1]] {
				continue
			}
			bareTen = true
		}
	}

	if bareTen {
		switch {
		case len(found) == 1 && found[TierAlt]:
			// "10" alongside the word "alt" — unambiguous Alt Loot, the
			// digits and the word agree.
		case len(found) == 0:
			return BidSignal{Tier: TierLow + " / " + TierAlt, Ambiguous: true, RawMessage: msg}
		default:
			found[TierLow] = true
		}
	}

	switch len(found) {
	case 0:
		return BidSignal{RawMessage: msg}
	case 1:
		for tier := range found {
			return BidSignal{Tier: tier, RawMessage: msg}
		}
	}

	tiers := make([]string, 0, len(found))
	for tier := range found {
		tiers = append(tiers, tier)
	}
	sort.Strings(tiers)
	return BidSignal{Tier: strings.Join(tiers, " / "), Ambiguous: true, RawMessage: msg}
}
