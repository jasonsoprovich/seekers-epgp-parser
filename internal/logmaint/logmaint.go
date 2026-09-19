// Package logmaint implements "Archive & Trim" for an EverQuest client log
// that's grown large enough to slow the app down — a real officer's log
// reached roughly 1 GB and made every Bids/Attendance capture noticeably
// laggy. Ported from the sibling pq-companion desktop app's own "Archive &
// Trim Log File" feature (its backend/internal/logparser/cleanup.go), with
// two deliberate improvements found by researching that codebase's own bug
// history before porting it:
//
//  1. The trim is written to a temp file and swapped in with one atomic
//     os.Rename, not an in-place os.WriteFile truncate+rewrite. pq-
//     companion's rewrite has no recovery if the process dies mid-write —
//     a temp file + rename means a crash leaves the original untouched.
//  2. The live file's size/mtime is re-checked immediately before the
//     swap, aborting if anything changed since the scan began. pq-
//     companion has no such re-check — only a coarser "hasn't been
//     written to in the last 2 minutes" gate up front, which its own
//     CHANGELOG (v0.17.4) shows was added after a real corruption-risk
//     bug report; this closes the remaining race that gate leaves open
//     (a write landing after the gate passes but during the scan).
//
// What this package deliberately does NOT attempt, matching pq-companion's
// own accepted trade-off: there's no true mutual-exclusion lock against
// the EverQuest client itself. EQ holds its own write handle open on the
// log file for the whole play session; the "hasn't been written to
// recently" checks are a heuristic gate on the button, not a guarantee.
// The officer still has to actually camp out of the zone first.
package logmaint

import (
	"archive/zip"
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// LiveWriteWindow: Archive & Trim refuses to run if the file was modified
// more recently than this. See the package doc for why this is a
// heuristic, not a lock.
const LiveWriteWindow = 2 * time.Minute

// lineTimestampRe / logTimeLayout deliberately duplicate parse package's
// own (unexported) log-line pattern rather than importing it: this
// package streams a potentially ~1 GB file line-by-line via bufio.Scanner
// to decide keep-or-drop, which doesn't need parse.splitLogLines' fuller
// LogLine allocation (fine for a single capture window's worth of lines,
// wasteful for a one-time whole-file scan).
var lineTimestampRe = regexp.MustCompile(`^\[([A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\]`)

const logTimeLayout = "Mon Jan _2 15:04:05 2006"

func lineTimestamp(line string) (time.Time, bool) {
	m := lineTimestampRe.FindStringSubmatch(line)
	if m == nil {
		return time.Time{}, false
	}
	t, err := time.ParseInLocation(logTimeLayout, m[1], time.Local)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// newScanner returns a bufio.Scanner sized for EQ log lines — 1 MB max,
// matching pq-companion's own choice, comfortably larger than any real
// line this game's client writes.
func newScanner(r io.Reader) *bufio.Scanner {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	return sc
}

// FileInfo is a size/date snapshot of one log file.
type FileInfo struct {
	Path        string
	Size        int64
	LargeFile   bool
	ModifiedAt  time.Time
	OldestEntry time.Time // zero if the file has no parseable line at all
	NewestEntry time.Time
}

// GetFileInfo stats path and does a bounded scan for its oldest and
// newest parseable line timestamps — from the start until the first
// parseable line (oldest), and backward from the last 64 KB (newest) —
// so this stays fast even on a huge file.
func GetFileInfo(path string, sizeWarningBytes int64) (FileInfo, error) {
	st, err := os.Stat(path)
	if err != nil {
		return FileInfo{}, err
	}
	info := FileInfo{
		Path:       path,
		Size:       st.Size(),
		LargeFile:  st.Size() >= sizeWarningBytes,
		ModifiedAt: st.ModTime(),
	}
	if oldest, ok := scanOldest(path); ok {
		info.OldestEntry = oldest
	}
	if newest, ok := scanNewest(path, st.Size()); ok {
		info.NewestEntry = newest
	}
	return info, nil
}

func scanOldest(path string) (time.Time, bool) {
	f, err := os.Open(path)
	if err != nil {
		return time.Time{}, false
	}
	defer f.Close()
	sc := newScanner(f)
	for sc.Scan() {
		if t, ok := lineTimestamp(sc.Text()); ok {
			return t, true
		}
	}
	return time.Time{}, false
}

const newestScanWindow = 64 * 1024

func scanNewest(path string, size int64) (time.Time, bool) {
	f, err := os.Open(path)
	if err != nil {
		return time.Time{}, false
	}
	defer f.Close()
	start := size - newestScanWindow
	if start < 0 {
		start = 0
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return time.Time{}, false
	}
	sc := newScanner(f)
	var best time.Time
	found := false
	// A partial first "line" from seeking mid-file naturally fails the
	// timestamp regex (it won't start with '[') and is skipped, same as
	// pq-companion's equivalent seek-and-scan.
	for sc.Scan() {
		if t, ok := lineTimestamp(sc.Text()); ok {
			best = t
			found = true
		}
	}
	return best, found
}

// RecentlyWritten reports whether path's mtime is within window of now.
// Uses the file's own mtime rather than a tailer's parsed "newest entry"
// state, so it works for any detected log — not just the one this app
// happens to be actively following right now.
func RecentlyWritten(path string, window time.Duration) (recently bool, modifiedAt time.Time, err error) {
	st, err := os.Stat(path)
	if err != nil {
		return false, time.Time{}, err
	}
	return time.Since(st.ModTime()) < window, st.ModTime(), nil
}

// testHookBeforeRecheck is set only by this package's own tests. See its
// call site in ArchiveAndTrim.
var testHookBeforeRecheck func()

// ArchiveResult is what one Archive & Trim run produced.
type ArchiveResult struct {
	BackupPath    string
	OriginalBytes int64
	KeptBytes     int64
}

// ArchiveAndTrim zips the ENTIRE current file to a verified backup next to
// it, then rewrites the live file to keep only lines within the last
// KeepDays — a line with no parseable timestamp is kept defensively,
// never silently dropped just because it couldn't be dated.
//
// beforeSwap, if non-nil, is called immediately before the final atomic
// rename — the caller's chance to release its own open handle on path
// (e.g. this app's log tailer) so Windows doesn't refuse the rename with
// a sharing violation against our own process. See app.go's
// ArchiveAndTrimLog, which closes the tailer only when path is the one
// it's currently following.
func ArchiveAndTrim(path string, keepDays int, targetBytes int64, beforeSwap func()) (ArchiveResult, error) {
	if keepDays < 1 || targetBytes < 1 {
		return ArchiveResult{}, errors.New("keep days and target bytes must be positive")
	}
	st, err := os.Stat(path)
	if err != nil {
		return ArchiveResult{}, err
	}
	originalSize := st.Size()
	originalModTime := st.ModTime()

	backupTemp, backupPath, err := newBackupPaths(path)
	if err != nil {
		return ArchiveResult{}, fmt.Errorf("creating backup: %w", err)
	}
	wantHash, err := zipFile(path, backupTemp)
	if err != nil {
		_ = os.Remove(backupTemp)
		return ArchiveResult{}, fmt.Errorf("writing backup: %w", err)
	}
	if err := verifyZipEntry(backupTemp, filepath.Base(path), originalSize, wantHash); err != nil {
		_ = os.Remove(backupTemp)
		return ArchiveResult{}, fmt.Errorf("backup verification failed, nothing was changed: %w", err)
	}
	if err := os.Rename(backupTemp, backupPath); err != nil {
		_ = os.Remove(backupTemp)
		return ArchiveResult{}, fmt.Errorf("publishing backup: %w", err)
	}

	temp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".trimming-*.tmp")
	if err != nil {
		return ArchiveResult{BackupPath: backupPath}, fmt.Errorf("creating trimmed log (your backup at %s is safe): %w", backupPath, err)
	}
	tempPath := temp.Name()
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempPath)
		return ArchiveResult{BackupPath: backupPath}, err
	}
	kept, err := writeFiltered(path, tempPath, st.Mode(), originalSize, keepDays, targetBytes)
	if err != nil {
		_ = os.Remove(tempPath)
		return ArchiveResult{BackupPath: backupPath}, fmt.Errorf("filtering log (your backup at %s is safe): %w", backupPath, err)
	}

	// Test-only seam: lets this package's own tests simulate a write
	// landing exactly between the scan finishing and the re-check below —
	// the race this re-check exists to catch. Always nil outside tests.
	if testHookBeforeRecheck != nil {
		testHookBeforeRecheck()
	}

	// Re-check immediately before the swap: if the live file grew or its
	// mtime moved since we started, something (almost certainly the EQ
	// client) wrote to it while we were reading — abort rather than swap
	// in content that's now missing whatever landed during the scan.
	st2, err := os.Stat(path)
	if err != nil {
		_ = os.Remove(tempPath)
		return ArchiveResult{BackupPath: backupPath}, fmt.Errorf("re-checking log before swap (your backup at %s is safe): %w", backupPath, err)
	}
	if st2.Size() != originalSize || !st2.ModTime().Equal(originalModTime) {
		_ = os.Remove(tempPath)
		return ArchiveResult{BackupPath: backupPath}, fmt.Errorf(
			"the log changed while archiving — your backup at %s is safe, but nothing was trimmed; make sure you're fully camped out and try again", backupPath)
	}

	if beforeSwap != nil {
		beforeSwap()
	}
	if err := os.Rename(tempPath, path); err != nil {
		return ArchiveResult{BackupPath: backupPath}, fmt.Errorf(
			"swapping in the trimmed log (your backup at %s is safe, original log untouched): %w", backupPath, err)
	}

	return ArchiveResult{BackupPath: backupPath, OriginalBytes: originalSize, KeptBytes: kept}, nil
}

func newBackupPaths(path string) (tempPath, finalPath string, err error) {
	dir := filepath.Dir(path)
	base := filepath.Base(path)
	base = strings.TrimSuffix(base, filepath.Ext(base))
	f, err := os.CreateTemp(dir, "."+base+"."+time.Now().Format("2006-01-02T150405")+".*.tmp")
	if err != nil {
		return "", "", err
	}
	tempPath = f.Name()
	if err := f.Close(); err != nil {
		_ = os.Remove(tempPath)
		return "", "", err
	}
	name := strings.TrimPrefix(filepath.Base(tempPath), ".")
	name = strings.TrimSuffix(name, ".tmp") + ".bak.zip"
	return tempPath, filepath.Join(dir, name), nil
}

func zipFile(srcPath, destZipPath string) (string, error) {
	src, err := os.Open(srcPath)
	if err != nil {
		return "", err
	}
	defer src.Close()

	out, err := os.OpenFile(destZipPath, os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return "", err
	}

	zw := zip.NewWriter(out)
	w, err := zw.CreateHeader(&zip.FileHeader{Name: filepath.Base(srcPath), Method: zip.Deflate})
	if err != nil {
		_ = zw.Close()
		_ = out.Close()
		return "", err
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(w, h), src); err != nil {
		_ = zw.Close()
		_ = out.Close()
		return "", err
	}
	if err := zw.Close(); err != nil {
		_ = out.Close()
		return "", err
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return "", err
	}
	if err := out.Close(); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func verifyZipEntry(zipPath, entryName string, wantSize int64, wantHash string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		if f.Name == entryName {
			if int64(f.UncompressedSize64) != wantSize { //nolint:gosec // sizes here are file sizes, never near uint64 overflow territory
				return fmt.Errorf("backup entry size %d does not match original %d", f.UncompressedSize64, wantSize)
			}
			rc, err := f.Open()
			if err != nil {
				return err
			}
			h := sha256.New()
			n, copyErr := io.Copy(h, rc)
			closeErr := rc.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
			if n != wantSize || hex.EncodeToString(h.Sum(nil)) != wantHash {
				return fmt.Errorf("backup content hash or size does not match original")
			}
			return nil
		}
	}
	return fmt.Errorf("backup zip has no entry named %q", entryName)
}

// writeFiltered streams src line-by-line into a brand-new file at
// destPath, keeping only lines within KeepDays of now (or any line whose
// timestamp can't be parsed at all). Returns the number of bytes kept.
// Streamed rather than pq-companion's whole-file-in-memory approach — one
// line at a time in, one line at a time out, so this doesn't need a
// second ~1 GB buffer alongside the original file's own OS page cache.
func writeFiltered(srcPath, destPath string, mode os.FileMode, sourceSize int64, keepDays int, targetBytes int64) (int64, error) {
	src, err := os.Open(srcPath)
	if err != nil {
		return 0, err
	}
	defer src.Close()

	out, err := os.OpenFile(destPath, os.O_WRONLY|os.O_TRUNC, mode.Perm())
	if err != nil {
		return 0, err
	}
	cutoff := time.Now().AddDate(0, 0, -keepDays)
	sc := newScanner(src)
	var offset, ageStart int64
	sawTimestamp := false
	ageStartSet := false
	for sc.Scan() {
		lineStart := offset
		offset += int64(len(sc.Bytes())) + 1
		if t, ok := lineTimestamp(sc.Text()); ok {
			sawTimestamp = true
			if !t.Before(cutoff) && !ageStartSet {
				ageStart = lineStart
				ageStartSet = true
			}
		}
	}
	if err := sc.Err(); err != nil {
		_ = out.Close()
		return 0, err
	}
	if sawTimestamp && !ageStartSet {
		ageStart = sourceSize
	}
	sizeStart := sourceSize - targetBytes
	if sizeStart < 0 {
		sizeStart = 0
	}
	if sizeStart > 0 {
		if _, err := src.Seek(sizeStart, io.SeekStart); err != nil {
			_ = out.Close()
			return 0, err
		}
		buf := make([]byte, 32*1024)
		for {
			n, readErr := src.Read(buf)
			if i := bytes.IndexByte(buf[:n], '\n'); i >= 0 {
				sizeStart += int64(i + 1)
				break
			}
			sizeStart += int64(n)
			if readErr != nil {
				if readErr == io.EOF {
					break
				}
				_ = out.Close()
				return 0, readErr
			}
		}
	}
	start := ageStart
	if sizeStart > start {
		start = sizeStart
	}
	if _, err := src.Seek(start, io.SeekStart); err != nil {
		_ = out.Close()
		return 0, err
	}
	kept, err := io.CopyN(out, src, sourceSize-start)
	if err != nil && err != io.EOF {
		_ = out.Close()
		return 0, err
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return 0, err
	}
	return kept, out.Close()
}
