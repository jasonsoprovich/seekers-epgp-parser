package bankexport

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ExportFile is one Zeal inventory export found on disk, matched to a
// character name (CharacterFromFileName) but not yet parsed.
type ExportFile struct {
	Character  string
	Path       string
	ModifiedAt time.Time
}

// Discover finds every "*-Inventory*.txt" Zeal export directly under
// gameDir — Zeal's /outputfile writes to the EQ install root itself, not
// the Logs subfolder internal/eqlogs.Discover scans, so this is a single,
// shallow directory read, not a multi-location scan like that package's.
//
// A character can have both filename variants on disk at once (Zeal
// re-writes whichever format the last /outputfile toggle left it on) —
// only the newer one (by mtime) is kept, mirroring pq-companion's own
// scanner.go byChar dedup. Matching is case-insensitive on the character
// name (EQ names are case-insensitive; a stale export from a differently-
// cased older Zeal build shouldn't produce a second phantom character).
//
// Like internal/eqlogs, this is pure filesystem inspection — no dialogs,
// no config, no Wails. Never returns a nil slice (frontend maps over the
// result with no defensive guard, same JSON null-vs-[] contract as the
// rest of this app) — an unreadable/missing directory is the one case
// that still returns an error.
func Discover(gameDir string) ([]ExportFile, error) {
	entries, err := os.ReadDir(gameDir)
	if err != nil {
		return nil, err
	}

	// Keyed by lowercased character name so "Darkclaw"/"darkclaw" collide.
	byChar := map[string]ExportFile{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		char := CharacterFromFileName(e.Name())
		if char == "" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue // vanished between ReadDir and stat — skip it
		}
		key := strings.ToLower(char)
		existing, ok := byChar[key]
		if ok && !info.ModTime().After(existing.ModifiedAt) {
			continue
		}
		byChar[key] = ExportFile{
			Character:  char,
			Path:       filepath.Join(gameDir, e.Name()),
			ModifiedAt: info.ModTime(),
		}
	}

	out := make([]ExportFile, 0, len(byChar))
	for _, f := range byChar {
		out = append(out, f)
	}
	return out, nil
}
