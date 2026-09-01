package eqlogs

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeLog creates <dir>/<name> with the given mtime.
func writeLog(t *testing.T, dir, name string, modAgo time.Duration) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("[Mon Aug 17 22:19:44 2026] You say to your guild, 'test'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	mt := time.Now().Add(-modAgo)
	if err := os.Chtimes(p, mt, mt); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestDiscover_FindsAndSortsByModTime(t *testing.T) {
	root := t.TempDir()
	logsDir := filepath.Join(root, "Logs")
	if err := os.MkdirAll(logsDir, 0o700); err != nil {
		t.Fatal(err)
	}

	writeLog(t, logsDir, "eqlog_Ammaru_pq.proj.txt", 2*time.Hour)
	writeLog(t, logsDir, "eqlog_Osui_pq.proj.txt", 1*time.Minute)
	writeLog(t, logsDir, "eqlog_Takkisina_pq.proj.txt", 30*time.Minute)
	// Noise that must not be picked up.
	writeLog(t, logsDir, "dbg.txt", time.Minute)
	writeLog(t, logsDir, "eqlog_NoServer.txt", time.Minute)
	if err := os.MkdirAll(filepath.Join(logsDir, "eqlog_ADir_pq.proj.txt"), 0o700); err != nil {
		t.Fatal(err)
	}

	logs, err := Discover(root)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(logs) != 3 {
		names := make([]string, len(logs))
		for i, l := range logs {
			names[i] = l.Character
		}
		t.Fatalf("got %d logs %v, want 3 (Osui, Takkisina, Ammaru)", len(logs), names)
	}
	if logs[0].Character != "Osui" || logs[1].Character != "Takkisina" || logs[2].Character != "Ammaru" {
		t.Errorf("wrong order: %s, %s, %s (want Osui, Takkisina, Ammaru)", logs[0].Character, logs[1].Character, logs[2].Character)
	}
	if logs[0].Server != "pq.proj" {
		t.Errorf("server = %q, want %q (must survive the dotted/last-underscore split)", logs[0].Server, "pq.proj")
	}
	if filepath.Base(logs[0].Path) != "eqlog_Osui_pq.proj.txt" {
		t.Errorf("path = %q, want it to end in eqlog_Osui_pq.proj.txt", logs[0].Path)
	}
}

func TestDiscover_AcceptsLogsDirDirectly(t *testing.T) {
	root := t.TempDir()
	logsDir := filepath.Join(root, "Logs")
	if err := os.MkdirAll(logsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeLog(t, logsDir, "eqlog_Osui_pq.proj.txt", time.Minute)

	logs, err := Discover(logsDir) // handed the Logs folder, not the root
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(logs) != 1 || logs[0].Character != "Osui" {
		t.Fatalf("got %+v, want one log for Osui", logs)
	}
}

func TestDiscover_FindsLogsLooseInRoot(t *testing.T) {
	root := t.TempDir() // no Logs subdir — logs sit directly in the root
	writeLog(t, root, "eqlog_Osui_pq.proj.txt", time.Minute)
	writeLog(t, root, "eqlog_Ammaru_pq.proj.txt", time.Hour)

	logs, err := Discover(root)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(logs) != 2 || logs[0].Character != "Osui" {
		t.Fatalf("got %+v, want Osui + Ammaru with Osui first", logs)
	}
}

func TestDiscover_DedupesRootAndLogs(t *testing.T) {
	root := t.TempDir()
	logsDir := filepath.Join(root, "Logs")
	if err := os.MkdirAll(logsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeLog(t, root, "eqlog_Osui_pq.proj.txt", 2*time.Minute)       // loose in root
	writeLog(t, logsDir, "eqlog_Takkisina_pq.proj.txt", time.Minute) // in Logs

	logs, err := Discover(root)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(logs) != 2 {
		t.Fatalf("got %d, want 2 (one from root, one from Logs)", len(logs))
	}
}

func TestDiscover_MissingLogsDirIsEmptyNotError(t *testing.T) {
	logs, err := Discover(t.TempDir()) // no Logs subdir at all
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if logs == nil {
		t.Fatal("logs is nil — must be an empty non-nil slice for the JSON contract")
	}
	if len(logs) != 0 {
		t.Fatalf("got %d logs, want 0", len(logs))
	}
}

func TestActive_PicksNewest(t *testing.T) {
	now := time.Now()
	logs := []CharacterLog{
		{Character: "Ammaru", ModifiedAt: now.Add(-time.Hour)},
		{Character: "Osui", ModifiedAt: now.Add(-time.Second)},
		{Character: "Takkisina", ModifiedAt: now.Add(-time.Minute)},
	}
	got, ok := Active(logs)
	if !ok || got.Character != "Osui" {
		t.Fatalf("Active = %+v, %v; want Osui", got, ok)
	}

	if _, ok := Active(nil); ok {
		t.Error("Active(nil) ok = true, want false")
	}
}

func TestParseLogName(t *testing.T) {
	cases := []struct {
		name         string
		char, server string
		ok           bool
	}{
		{"eqlog_Osui_pq.proj.txt", "Osui", "pq.proj", true},
		{"eqlog_Takkisina_project1999.txt", "Takkisina", "project1999", true},
		{"eqlog_Some_Name_pq.proj.txt", "Some_Name", "pq.proj", true}, // char with underscore: last "_" wins
		{"eqlog_Osui_.txt", "", "", false},
		{"eqlog_pq.proj.txt", "", "", false}, // no separator
		{"eqlog__pq.proj.txt", "", "", false},
		{"notalog.txt", "", "", false},
		{"eqlog_Osui_pq.proj.log", "", "", false},
	}
	for _, c := range cases {
		char, server, ok := parseLogName(c.name)
		if ok != c.ok || char != c.char || server != c.server {
			t.Errorf("parseLogName(%q) = (%q, %q, %v), want (%q, %q, %v)", c.name, char, server, ok, c.char, c.server, c.ok)
		}
	}
}
