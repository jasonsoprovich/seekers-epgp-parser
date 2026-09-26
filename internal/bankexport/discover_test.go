package bankexport

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDiscover(t *testing.T) {
	files, err := Discover("testdata")
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if files == nil {
		t.Fatal("Discover must never return a nil slice")
	}

	byChar := map[string]ExportFile{}
	for _, f := range files {
		byChar[f.Character] = f
	}
	if _, ok := byChar["TestMule1"]; !ok {
		t.Errorf("expected TestMule1 in %+v", files)
	}
	if _, ok := byChar["TestMule2"]; !ok {
		t.Errorf("expected TestMule2 in %+v", files)
	}
}

// A character can have both filename formats on disk (Zeal re-writes
// whichever the last /outputfile toggle left it on) — only the newer one
// by mtime should be kept.
func TestDiscoverKeepsNewerFilenameVariant(t *testing.T) {
	dir := t.TempDir()

	older := filepath.Join(dir, "Darkclaw-Inventory.txt")
	newer := filepath.Join(dir, "Darkclaw-Inventory_pq.proj.txt")
	if err := os.WriteFile(older, []byte("Location\tName\tID\tCount/Charges\tSlots\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(newer, []byte("Location\tName\tID\tCount/Charges\tSlots\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := os.Chtimes(older, now.Add(-time.Hour), now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(newer, now, now); err != nil {
		t.Fatal(err)
	}

	files, err := Discover(dir)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("expected exactly one file for Darkclaw, got %+v", files)
	}
	if files[0].Path != newer {
		t.Errorf("Path = %q, want the newer file %q", files[0].Path, newer)
	}
}

func TestDiscoverMissingDirectory(t *testing.T) {
	if _, err := Discover(filepath.Join("testdata", "does-not-exist")); err == nil {
		t.Error("expected an error for a missing directory")
	}
}
