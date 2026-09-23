package parse

import "testing"

func TestDetectBidSignal(t *testing.T) {
	cases := []struct {
		name       string
		msg        string
		wantTier   string
		wantAmbig  bool
		wantCancel bool
	}{
		{"bare high", "high", TierHigh, false, false},
		{"bare low", "low", TierLow, false, false},
		{"item then tier", "Soul Essence of Aten Ha Ra high", TierHigh, false, false},
		{"tier then item, all caps", "Soul Essence of Aten Ha Ra HIGH", TierHigh, false, false},
		{"hyphen-glued to item", "High-Soul Essence of Aten Ha Ra", TierHigh, false, false},
		{"extra filler word", "high for Soul Essence of Aten Ha Ra", TierHigh, false, false},
		{"trailing word bid", "Soul Essence of Aten Ha Ra high bid", TierHigh, false, false},
		{"trailing commentary", "high and a hundo to ignore Grok :D", TierHigh, false, false},
		{"major synonym", "Major", TierHigh, false, false},
		{"slight synonym", "slight", TierMed, false, false},
		{"med synonym", "med", TierMed, false, false},
		{"mid synonym", "mid", TierMed, false, false},
		{"mid glued to item", "Cloak of Flames mid", TierMed, false, false},
		{"main + tier", "main high", TierHigh, false, false},
		{"change to tier", "change to low", TierLow, false, false},
		{"filler then tier", "pretty pretty princess high", TierHigh, false, false},
		{"numeric 100", "Soul Essence of Aten Ha Ra 100", TierHigh, false, false},
		{"numeric 50", "50", TierMed, false, false},
		{"bare 10 is a low bid", "10", TierLow, false, false},
		{"alt word", "alt", TierAlt, false, false},
		{"rot word", "rot", TierRot, false, false},
		{"10 with alt resolves to alt", "alt 10", TierAlt, false, false},
		{"10 with rot resolves to rot", "10 rot", TierRot, false, false},
		{"cancel my bid", "cancel my bid", "", false, true},
		{"retract", "retract", "", false, true},
		{"cancel then re-bid in one line", "cancel, actually high", TierHigh, true, false},
		{"10 minutes is a duration, not a bid", "I have a zoom board meeting starting in 10 minutes, so I need to log.", "", false, false},
		{"unrelated chat", "I have a zoom meeting, gotta log", "", false, false},
		{"unrelated single word", "invite", "", false, false},
		{"conflicting tiers", "high or low idk", TierHigh + " / " + TierLow, true, false},

		// "med" variants (2026-09-21 live test: officer confirmed "med" was
		// already working; these pin the synonym and the punctuation/
		// slash-glued phrasings actually seen).
		{"med bare", "med", TierMed, false, false},
		{"med trailing period", "Med.", TierMed, false, false},
		{"med all caps", "MED", TierMed, false, false},
		{"main then med", "main med", TierMed, false, false},
		{"med then bid", "med bid", TierMed, false, false},
		{"med slash main", "med/main", TierMed, false, false},
		{"med in parens", "(med)", TierMed, false, false},
		{"med with please", "med please", TierMed, false, false},

		// Regression: splitting on '/' for "med/main" must not turn a date
		// into a bare numeric bid. Real sample line: "I got my vacation
		// dates wrong on my post... Gone 9/1 to 9/10. I'll repost the
		// correct info." — no bid signal at all.
		{"date range is not a bid", "Gone 9/1 to 9/10. I'll repost the correct info.", "", false, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := DetectBidSignal(tc.msg)
			if got.Tier != tc.wantTier {
				t.Errorf("DetectBidSignal(%q).Tier = %q, want %q", tc.msg, got.Tier, tc.wantTier)
			}
			if got.Ambiguous != tc.wantAmbig {
				t.Errorf("DetectBidSignal(%q).Ambiguous = %v, want %v", tc.msg, got.Ambiguous, tc.wantAmbig)
			}
			if got.Cancel != tc.wantCancel {
				t.Errorf("DetectBidSignal(%q).Cancel = %v, want %v", tc.msg, got.Cancel, tc.wantCancel)
			}
		})
	}
}
