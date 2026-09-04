package parse

import (
	_ "embed"
	"testing"
	"time"
)

//go:embed testdata/attendance_sample.txt
var attendanceSample string

func TestParseAttendance_RealSample(t *testing.T) {
	snapshots, warnings := ParseAttendance(attendanceSample)

	if len(warnings) != 0 {
		t.Fatalf("expected no warnings, got %v", warnings)
	}
	if len(snapshots) != 1 {
		t.Fatalf("expected 1 snapshot, got %d", len(snapshots))
	}

	snap := snapshots[0]
	if snap.Zone != "Sanctus Seru" {
		t.Errorf("zone = %q, want %q", snap.Zone, "Sanctus Seru")
	}
	if snap.ExpectedCount != 42 {
		t.Errorf("expectedCount = %d, want 42", snap.ExpectedCount)
	}
	if len(snap.Names) != 42 {
		t.Fatalf("len(names) = %d, want 42", len(snap.Names))
	}

	wantTime := time.Date(2026, time.August, 19, 22, 35, 21, 0, time.Local)
	if !snap.OccurredAt.Equal(wantTime) {
		t.Errorf("occurredAt = %v, want %v", snap.OccurredAt, wantTime)
	}

	if snap.Names[0] != "Kuky" {
		t.Errorf("names[0] = %q, want %q (first row, normal format)", snap.Names[0], "Kuky")
	}
	if last := snap.Names[len(snap.Names)-1]; last != "Sandrian" {
		t.Errorf("last name = %q, want %q (last row, normal format)", last, "Sandrian")
	}

	found := map[string]bool{}
	for _, n := range snap.Names {
		found[n] = true
	}
	for _, anon := range []string{"Hawthor", "Luna", "Kaalos", "Narya", "Glepina", "Takkisina"} {
		if !found[anon] {
			t.Errorf("expected anonymous row %q to be parsed, wasn't found", anon)
		}
	}
}

func TestParseAttendance_MismatchedCountWarns(t *testing.T) {
	raw := `[Wed Aug 19 22:35:21 2026] Players on EverQuest:
[Wed Aug 19 22:35:21 2026] ---------------------------
[Wed Aug 19 22:35:21 2026] [60 Warlock] Kuky (Unknown) <Seekers of Souls>
[Wed Aug 19 22:35:21 2026] There are 2 players in Sanctus Seru.`

	snapshots, warnings := ParseAttendance(raw)
	if len(snapshots) != 1 {
		t.Fatalf("expected 1 snapshot despite the mismatch, got %d", len(snapshots))
	}
	if len(warnings) != 1 {
		t.Fatalf("expected 1 warning for the count mismatch, got %d: %v", len(warnings), warnings)
	}
}

func TestParseAttendance_PrefersEnteredZoneOverWhoFooter(t *testing.T) {
	// Officer runs `/who guild` (to catch anonymous raiders too), so the
	// footer says "EverQuest", not the raid zone — but they zoned into Vex
	// Thal earlier. The snapshot should report Vex Thal.
	raw := `[Wed Aug 19 21:00:00 2026] You have entered the Nexus.
[Wed Aug 19 21:05:00 2026] You have entered Vex Thal.
[Wed Aug 19 21:05:01 2026] You have entered an area where levitation effects do not function.
[Wed Aug 19 22:35:21 2026] Players on EverQuest:
[Wed Aug 19 22:35:21 2026] ---------------------------
[Wed Aug 19 22:35:21 2026] [60 Warlock] Kuky (Unknown) <Seekers of Souls>
[Wed Aug 19 22:35:21 2026] [ANONYMOUS] Hawthor  <Seekers of Souls>
[Wed Aug 19 22:35:21 2026] There are 2 players in EverQuest.`

	snapshots, warnings := ParseAttendance(raw)
	if len(warnings) != 0 {
		t.Fatalf("expected no warnings, got %v", warnings)
	}
	if len(snapshots) != 1 {
		t.Fatalf("expected 1 snapshot, got %d", len(snapshots))
	}
	if snapshots[0].Zone != "Vex Thal" {
		t.Errorf("zone = %q, want %q (the zone-in, not the /who footer)", snapshots[0].Zone, "Vex Thal")
	}
}

func TestParseAttendance_FallsBackToFooterWhenNoZoneIn(t *testing.T) {
	// No "You have entered" line in the captured range (paste starts
	// mid-zone) — fall back to the /who footer, and ignore the levitation
	// line so it doesn't get mistaken for a zone.
	raw := `[Wed Aug 19 22:35:20 2026] You have entered an area where levitation effects do not function.
[Wed Aug 19 22:35:21 2026] Players on EverQuest:
[Wed Aug 19 22:35:21 2026] ---------------------------
[Wed Aug 19 22:35:21 2026] [60 Warlock] Kuky (Unknown) <Seekers of Souls>
[Wed Aug 19 22:35:21 2026] There are 1 players in Sanctus Seru.`

	snapshots, _ := ParseAttendance(raw)
	if len(snapshots) != 1 {
		t.Fatalf("expected 1 snapshot, got %d", len(snapshots))
	}
	if snapshots[0].Zone != "Sanctus Seru" {
		t.Errorf("zone = %q, want %q (footer fallback)", snapshots[0].Zone, "Sanctus Seru")
	}
}

func TestParseAttendance_UnclosedBlockWarnsAndSkips(t *testing.T) {
	raw := `[Wed Aug 19 22:35:21 2026] Players on EverQuest:
[Wed Aug 19 22:35:21 2026] ---------------------------
[Wed Aug 19 22:35:21 2026] [60 Warlock] Kuky (Unknown) <Seekers of Souls>
[Wed Aug 19 22:35:22 2026] Someone says, 'hi'`

	snapshots, warnings := ParseAttendance(raw)
	if len(snapshots) != 0 {
		t.Fatalf("expected no snapshots for an unclosed block, got %d", len(snapshots))
	}
	if len(warnings) != 1 {
		t.Fatalf("expected 1 warning for the unclosed block, got %d: %v", len(warnings), warnings)
	}
}
