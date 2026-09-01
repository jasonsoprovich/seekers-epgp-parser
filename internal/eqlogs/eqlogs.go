// Package eqlogs discovers the per-character EverQuest client log files
// under a game install directory and picks the one currently being written
// to — the "active character". An officer raids on their main or an alt
// depending on what classes the raid needs, and each character writes its
// own eqlog_<Character>_<server>.txt, so pinning a single hardcoded path
// (the app's old behaviour) silently watches a stale log the moment they
// swap. This mirrors how PQ Companion resolves the log: point it at the
// game folder, let it follow whichever character is live.
//
// Like internal/parse, this package is pure filesystem inspection — no
// dialogs, no config, no Wails. The caller owns asking the officer for the
// directory and persisting it.
package eqlogs

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// CharacterLog is one eqlog_<Character>_<server>.txt found under a game
// directory's Logs folder.
type CharacterLog struct {
	Character  string    `json:"character"`
	Server     string    `json:"server"`
	Path       string    `json:"path"`
	ModifiedAt time.Time `json:"modifiedAt"`
	Size       int64     `json:"size"`
}

// logsSubdir is where the EQ client keeps per-character logs, relative to
// the install root. Discover also accepts being handed this folder
// directly.
const logsSubdir = "Logs"

// filePrefix / fileSuffix bracket the "<Character>_<server>" middle of an
// EQ client log filename.
const (
	filePrefix = "eqlog_"
	fileSuffix = ".txt"
)

// Discover returns every character log under gameDir, newest first. gameDir
// may be the EverQuest install root (the common case — the folder holding
// eqgame.exe and Logs/), that root's Logs folder directly, or a root whose
// eqlog_*.txt files sit loose in it rather than a Logs subfolder — all
// three get scanned, deduped by path. A directory with no matching logs is
// not an error — it returns an empty slice, so the caller can tell "wrong
// folder" (this) from "couldn't read the folder" (err).
func Discover(gameDir string) ([]CharacterLog, error) {
	clean := filepath.Clean(gameDir)
	// Scan gameDir itself and, unless it already IS a Logs folder, its Logs
	// subfolder. The EQ client writes to <root>/Logs/ ~always, but a
	// hand-copied log or an odd install can leave them in the root.
	dirs := []string{clean}
	if !strings.EqualFold(filepath.Base(clean), logsSubdir) {
		dirs = append(dirs, filepath.Join(clean, logsSubdir))
	}

	// Never nil — the frontend maps over this without a guard, same JSON
	// null-vs-[] contract as the rest of the app.
	out := []CharacterLog{}
	seen := map[string]bool{}
	var readErr error
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			if !os.IsNotExist(err) {
				readErr = err
			}
			continue
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			char, server, ok := parseLogName(e.Name())
			if !ok {
				continue
			}
			path := filepath.Join(dir, e.Name())
			if seen[path] {
				continue
			}
			seen[path] = true
			info, err := e.Info()
			if err != nil {
				continue // vanished between ReadDir and stat — skip it
			}
			out = append(out, CharacterLog{
				Character:  char,
				Server:     server,
				Path:       path,
				ModifiedAt: info.ModTime(),
				Size:       info.Size(),
			})
		}
	}
	// Only surface a read error when it left us with nothing — a partial
	// scan that still found logs is more useful than an error.
	if len(out) == 0 && readErr != nil {
		return nil, readErr
	}

	sort.Slice(out, func(i, j int) bool {
		if !out[i].ModifiedAt.Equal(out[j].ModifiedAt) {
			return out[i].ModifiedAt.After(out[j].ModifiedAt)
		}
		return out[i].Character < out[j].Character
	})
	return out, nil
}

// Active returns the most-recently-written log — the character the officer
// is currently playing. ok is false for an empty slice. Discover already
// sorts newest-first, so this is just the head, but callers pass their own
// (possibly filtered or re-sorted) slice, so re-scan rather than trust the
// order.
func Active(logs []CharacterLog) (CharacterLog, bool) {
	if len(logs) == 0 {
		return CharacterLog{}, false
	}
	best := logs[0]
	for _, l := range logs[1:] {
		if l.ModifiedAt.After(best.ModifiedAt) {
			best = l
		}
	}
	return best, true
}

// parseLogName splits "eqlog_<Character>_<server>.txt" into its character
// and server parts. The server shortname itself contains dots and can
// contain underscores ("pq.proj", and the guild's real files are
// "..._pq.proj.txt"), so split on the LAST underscore, not the first — the
// character name is everything between the prefix and that final "_".
func parseLogName(name string) (character, server string, ok bool) {
	if !strings.HasPrefix(name, filePrefix) || !strings.HasSuffix(name, fileSuffix) {
		return "", "", false
	}
	middle := name[len(filePrefix) : len(name)-len(fileSuffix)]
	i := strings.LastIndex(middle, "_")
	if i <= 0 || i == len(middle)-1 {
		return "", "", false // no separator, or an empty character/server half
	}
	return middle[:i], middle[i+1:], true
}
