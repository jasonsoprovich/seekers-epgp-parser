package parse

import "testing"

func TestDetectBidSignal(t *testing.T) {
	cases := []struct {
		name      string
		msg       string
		wantTier  string
		wantAmbig bool
	}{
		{"bare high", "high", TierHigh, false},
		{"bare low", "low", TierLow, false},
		{"item then tier", "Soul Essence of Aten Ha Ra high", TierHigh, false},
		{"tier then item, all caps", "Soul Essence of Aten Ha Ra HIGH", TierHigh, false},
		{"hyphen-glued to item", "High-Soul Essence of Aten Ha Ra", TierHigh, false},
		{"extra filler word", "high for Soul Essence of Aten Ha Ra", TierHigh, false},
		{"trailing word bid", "Soul Essence of Aten Ha Ra high bid", TierHigh, false},
		{"trailing commentary", "high and a hundo to ignore Grok :D", TierHigh, false},
		{"major synonym", "Major", TierHigh, false},
		{"slight synonym", "slight", TierMed, false},
		{"numeric 100", "Soul Essence of Aten Ha Ra 100", TierHigh, false},
		{"numeric 50", "50", TierMed, false},
		{"alt word", "alt", TierAlt, false},
		{"bare 10 is ambiguous", "10", TierLow + " / " + TierAlt, true},
		{"10 with alt resolves cleanly", "alt 10", TierAlt, false},
		{"10 minutes is a duration, not a bid", "I have a zoom board meeting starting in 10 minutes, so I need to log.", "", false},
		{"unrelated chat", "I have a zoom meeting, gotta log", "", false},
		{"unrelated single word", "invite", "", false},
		{"conflicting tiers", "high or low idk", TierHigh + " / " + TierLow, true},
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
		})
	}
}
