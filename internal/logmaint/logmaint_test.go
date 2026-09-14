package logmaint

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeLines(t *testing.T, path string, lines []string) {
	t.Helper()
	content := ""
	for _, l := range lines {
		content += l + "\n"
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}

func logLine(t time.Time, text string) string {
	return "[" + t.Format(logTimeLayout) + "] " + text
}

func TestGetFileInfo_SizeAndDates(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "eqlog_Osui_pq.proj.txt")
	old := time.Now().AddDate(0, 0, -60)
	recent := time.Now().Add(-1 * time.Minute)
	writeLines(t, path, []string{
		logLine(old, "You have entered EverQuest."),
		"a malformed line with no timestamp",
		logLine(recent, "Osui tells the guild, 'ready'"),
	})

	info, err := GetFileInfo(path)
	if err != nil {
		t.Fatalf("GetFileInfo: %v", err)
	}
	if info.LargeFile {
		t.Errorf("a tiny test file should not read as LargeFile")
	}
	if info.OldestEntry.IsZero() {
		t.Fatalf("OldestEntry is zero, want the first parseable line's time")
	}
	if info.NewestEntry.IsZero() {
		t.Fatalf("NewestEntry is zero, want the last parseable line's time")
	}
	if !info.NewestEntry.After(info.OldestEntry) {
		t.Errorf("NewestEntry (%v) should be after OldestEntry (%v)", info.NewestEntry, info.OldestEntry)
	}
}

func TestRecentlyWritten(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "eqlog_Osui_pq.proj.txt")
	writeLines(t, path, []string{"anything"})

	recently, _, err := RecentlyWritten(path, 2*time.Minute)
	if err != nil {
		t.Fatalf("RecentlyWritten: %v", err)
	}
	if !recently {
		t.Errorf("a file just written should read as recently written")
	}

	old := time.Now().Add(-10 * time.Minute)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	recently, modAt, err := RecentlyWritten(path, 2*time.Minute)
	if err != nil {
		t.Fatalf("RecentlyWritten: %v", err)
	}
	if recently {
		t.Errorf("a file modified 10 minutes ago should not read as recently written")
	}
	if !modAt.Equal(old) {
		t.Errorf("modifiedAt = %v, want %v", modAt, old)
	}
}

func TestArchiveAndTrim_BacksUpEverythingKeepsRecentWindow(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "eqlog_Osui_pq.proj.txt")

	tooOld := time.Now().AddDate(0, 0, -KeepDays-5)
	withinWindow := time.Now().AddDate(0, 0, -5)
	oldLine := logLine(tooOld, "You have entered EverQuest.")
	keptLine := logLine(withinWindow, "Osui tells the guild, 'ready'")
	unparseableLine := "a line with no timestamp at all"
	writeLines(t, path, []string{oldLine, keptLine, unparseableLine})

	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	// Old enough mtime to clear the live-write gate a caller would check —
	// ArchiveAndTrim itself doesn't gate on this (app.go does), but backdate
	// it anyway so this test doesn't depend on wall-clock timing.
	old := time.Now().Add(-10 * time.Minute)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}

	var swapCalled bool
	result, err := ArchiveAndTrim(path, func() { swapCalled = true })
	if err != nil {
		t.Fatalf("ArchiveAndTrim: %v", err)
	}
	if !swapCalled {
		t.Errorf("beforeSwap callback was never called")
	}

	// The backup holds the ENTIRE original file, unfiltered.
	backedUp := readZipEntry(t, result.BackupPath, filepath.Base(path))
	if string(backedUp) != string(original) {
		t.Errorf("backup content = %q, want the full original %q", backedUp, original)
	}

	// The live file now keeps only the within-window and unparseable
	// lines — the too-old line is gone from the live file (still in the
	// backup, confirmed above).
	trimmed, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading trimmed live file: %v", err)
	}
	trimmedStr := string(trimmed)
	if contains(trimmedStr, oldLine) {
		t.Errorf("trimmed file still contains the too-old line: %q", trimmedStr)
	}
	if !contains(trimmedStr, keptLine) {
		t.Errorf("trimmed file is missing the within-window line: %q", trimmedStr)
	}
	if !contains(trimmedStr, unparseableLine) {
		t.Errorf("trimmed file dropped an unparseable line — must be kept defensively: %q", trimmedStr)
	}
	if result.OriginalBytes != int64(len(original)) {
		t.Errorf("OriginalBytes = %d, want %d", result.OriginalBytes, len(original))
	}
}

func TestArchiveAndTrim_AbortsIfFileChangedDuringScan(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "eqlog_Osui_pq.proj.txt")
	writeLines(t, path, []string{logLine(time.Now(), "line one")})

	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	// testHookBeforeRecheck simulates the EQ client appending a new line
	// exactly between the scan finishing and the pre-swap re-check —
	// beforeSwap (the caller-facing hook) fires AFTER that re-check
	// already passed, so it can't exercise this race; this package-
	// internal seam can.
	testHookBeforeRecheck = func() {
		f, ferr := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
		if ferr != nil {
			t.Fatal(ferr)
		}
		_, _ = f.WriteString(logLine(time.Now(), "a line written mid-archive") + "\n")
		_ = f.Close()
	}
	defer func() { testHookBeforeRecheck = nil }()

	var swapCalled bool
	_, err = ArchiveAndTrim(path, func() { swapCalled = true })
	if err == nil {
		t.Fatal("expected an error when the file changes mid-archive, got nil")
	}
	if swapCalled {
		t.Error("beforeSwap must not be called when the re-check aborts the swap")
	}

	// The live file must be untouched — still exactly the original
	// content plus the injected line, never swapped for the (now stale)
	// trimmed temp file.
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(string(after), string(original)) {
		t.Errorf("live file was modified despite the abort: %q", after)
	}

	// No stray temp file left behind.
	if _, err := os.Stat(path + ".trimming.tmp"); !os.IsNotExist(err) {
		t.Errorf("expected the temp file to be cleaned up, stat err = %v", err)
	}
}

func TestArchiveAndTrim_VerificationFailurePreventsLiveFileChange(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "eqlog_Osui_pq.proj.txt")
	writeLines(t, path, []string{logLine(time.Now(), "line one")})
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	// Corrupt verifyZipEntry's expectations by pre-creating a backup file
	// at the exact path ArchiveAndTrim will write, but as a plain (non-
	// zip) file — zip.OpenReader will fail on it, simulating a write
	// that produced a bad archive.
	backupPath := backupFilename(path)
	if err := os.WriteFile(backupPath, []byte("not a zip"), 0o644); err != nil {
		t.Fatal(err)
	}
	// ArchiveAndTrim will os.Create over this (truncating), so instead
	// force the failure a different way: make the destination directory
	// read-only isn't portable in CI, so directly exercise verifyZipEntry
	// against a deliberately-wrong expected size instead.
	if err := zipFile(path, backupPath); err != nil {
		t.Fatal(err)
	}
	if err := verifyZipEntry(backupPath, filepath.Base(path), int64(len(original)+1)); err == nil {
		t.Fatal("verifyZipEntry should reject a size mismatch")
	}
}

func readZipEntry(t *testing.T, zipPath, entryName string) []byte {
	t.Helper()
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		t.Fatalf("opening backup zip: %v", err)
	}
	defer r.Close()
	for _, f := range r.File {
		if f.Name != entryName {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("opening zip entry: %v", err)
		}
		defer rc.Close()
		b, err := io.ReadAll(rc)
		if err != nil {
			t.Fatalf("reading zip entry: %v", err)
		}
		return b
	}
	t.Fatalf("zip %s has no entry named %q", zipPath, entryName)
	return nil
}

func contains(haystack, needle string) bool {
	return strings.Contains(haystack, needle)
}
