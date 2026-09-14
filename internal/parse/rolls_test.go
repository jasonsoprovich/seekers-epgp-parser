package parse

import (
	_ "embed"
	"testing"
	"time"
)

//go:embed testdata/rolls_sample.txt
var rollsSample string

func TestParseRollEvents_RealSample(t *testing.T) {
	events := ParseRollEvents(rollsSample)
	if len(events) != 5 {
		t.Fatalf("got %d roll events, want 5: %+v", len(events), events)
	}
	if events[0].Roller != "Tabbie" || events[0].Min != 0 || events[0].Max != 222 || events[0].Value != 69 {
		t.Errorf("events[0] = %+v, unexpected", events[0])
	}
	if events[4].Roller != "Grokenspiel" || events[4].Max != 100 || events[4].Value != 42 {
		t.Errorf("events[4] = %+v, unexpected", events[4])
	}
}

func TestBucketRollEvents_GroupsByRange(t *testing.T) {
	events := ParseRollEvents(rollsSample)
	sessions := BucketRollEvents(events, nil, time.Time{})

	if len(sessions) != 2 {
		t.Fatalf("got %d sessions, want 2 (one for 0-222, one for 0-100): %+v", len(sessions), sessions)
	}
	s := sessions[0]
	if s.Min != 0 || s.Max != 222 || len(s.Rolls) != 4 {
		t.Fatalf("sessions[0] = %+v, want min=0 max=222 with 4 rolls", s)
	}
	if sessions[1].Max != 100 || len(sessions[1].Rolls) != 1 {
		t.Fatalf("sessions[1] = %+v, want max=100 with 1 roll", sessions[1])
	}
}

func TestBucketRollEvents_DuplicateFlaggedOnReroll(t *testing.T) {
	events := ParseRollEvents(rollsSample)
	sessions := BucketRollEvents(events, nil, time.Time{})
	s := sessions[0] // the 0-222 session: Tabbie, Osui, Kaalos, Osui again

	var osuiSeen int
	for _, r := range s.Rolls {
		if r.Roller != "Osui" {
			continue
		}
		osuiSeen++
		if osuiSeen == 1 && r.Duplicate {
			t.Errorf("Osui's first roll should not be flagged duplicate")
		}
		if osuiSeen == 2 && !r.Duplicate {
			t.Errorf("Osui's second roll should be flagged duplicate")
		}
	}
	if osuiSeen != 2 {
		t.Fatalf("expected 2 rolls from Osui, saw %d", osuiSeen)
	}
}

func TestWinnersOf_HighestIgnoresDuplicateReroll(t *testing.T) {
	events := ParseRollEvents(rollsSample)
	sessions := BucketRollEvents(events, nil, time.Time{})
	s := sessions[0] // Tabbie 69, Osui 185 (first), Kaalos 185, Osui 12 (duplicate, ignored)

	winners := WinnersOf(s.Rolls, true)
	if len(winners) != 2 {
		t.Fatalf("got winners %v, want a tie between Osui and Kaalos at 185", winners)
	}
	want := map[string]bool{"Osui": true, "Kaalos": true}
	for _, w := range winners {
		if !want[w] {
			t.Errorf("unexpected winner %q", w)
		}
	}
}

func TestWinnersOf_Lowest(t *testing.T) {
	events := ParseRollEvents(rollsSample)
	sessions := BucketRollEvents(events, nil, time.Time{})
	s := sessions[0]

	winners := WinnersOf(s.Rolls, false)
	if len(winners) != 1 || winners[0] != "Tabbie" {
		t.Fatalf("got winners %v, want just Tabbie at 69", winners)
	}
}

func TestBucketRollEvents_ClearedBeforeFloor(t *testing.T) {
	events := ParseRollEvents(rollsSample)
	// Clear everything up through the 0-222 session's last roll — only
	// the later 0-100 session should remain.
	cutoff := events[3].OccurredAt // Osui's second (12) roll
	sessions := BucketRollEvents(events, nil, cutoff)
	if len(sessions) != 1 || sessions[0].Max != 100 {
		t.Fatalf("got %+v, want only the 0-100 session to survive the clear", sessions)
	}
}

func TestBucketRollEvents_BoundaryForcesNewSession(t *testing.T) {
	events := ParseRollEvents(rollsSample)
	// A boundary set right after Kaalos's roll (the 3rd event in the
	// 0-222 range) should split Osui's later reroll into its own session
	// instead of it joining the original one.
	boundary := events[2].OccurredAt.Add(1 * time.Second)
	sessions := BucketRollEvents(events, map[string]time.Time{RangeKey(0, 222): boundary}, time.Time{})

	var rangeSessions []RollSession
	for _, s := range sessions {
		if s.Min == 0 && s.Max == 222 {
			rangeSessions = append(rangeSessions, s)
		}
	}
	if len(rangeSessions) != 2 {
		t.Fatalf("got %d sessions in the 0-222 range, want 2 (boundary should split them): %+v", len(rangeSessions), rangeSessions)
	}
	if len(rangeSessions[0].Rolls) != 3 {
		t.Errorf("first session should keep Tabbie/Osui/Kaalos (3 rolls), got %d", len(rangeSessions[0].Rolls))
	}
	if len(rangeSessions[1].Rolls) != 1 || rangeSessions[1].Rolls[0].Duplicate {
		t.Errorf("second session should start fresh with Osui's reroll, not-duplicate, got %+v", rangeSessions[1].Rolls)
	}
}
