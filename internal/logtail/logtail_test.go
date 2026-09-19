package logtail

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}

func TestTailer_IncrementalGrowth(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "eqlog.txt")
	mustWrite(t, path, "line one\n")

	tl := New(path, 0)
	defer tl.Close()

	got, err := tl.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got != "line one\n" {
		t.Fatalf("first Read = %q, want %q", got, "line one\n")
	}
	if st := tl.Stat(); st.Resets != 1 {
		t.Fatalf("Stat().Resets = %d after first read, want 1", st.Resets)
	}

	// Append, simulating the EQ client writing more lines while the app
	// keeps polling.
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("opening for append: %v", err)
	}
	if _, err := f.WriteString("line two\n"); err != nil {
		t.Fatalf("appending: %v", err)
	}
	_ = f.Close()

	got, err = tl.Read()
	if err != nil {
		t.Fatalf("Read after append: %v", err)
	}
	want := "line one\nline two\n"
	if got != want {
		t.Fatalf("Read after append = %q, want %q", got, want)
	}
	if st := tl.Stat(); st.Resets != 1 {
		t.Fatalf("Stat().Resets = %d after ordinary growth, want still 1 (no reset)", st.Resets)
	}

	// A third, no-op Read (nothing appended) must return the same content
	// without erroring or duplicating anything.
	got, err = tl.Read()
	if err != nil {
		t.Fatalf("Read with no growth: %v", err)
	}
	if got != want {
		t.Fatalf("no-growth Read = %q, want %q", got, want)
	}
}

func TestTailer_PartialLineAcrossReads(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "eqlog.txt")
	// Write a line's bytes with no trailing newline yet — as if the EQ
	// client's write landed on the wire mid-line at the exact moment we
	// polled.
	mustWrite(t, path, "[Wed Sep 10 20:15:0")

	tl := New(path, 0)
	defer tl.Close()

	got, err := tl.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got != "" {
		t.Fatalf("Read of partial line = %q, want it buffered until newline", got)
	}

	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("opening for append: %v", err)
	}
	if _, err := f.WriteString("5 2026] You told Bob, 'hi'\n"); err != nil {
		t.Fatalf("appending: %v", err)
	}
	_ = f.Close()

	got, err = tl.Read()
	if err != nil {
		t.Fatalf("Read after completing the line: %v", err)
	}
	want := "[Wed Sep 10 20:15:05 2026] You told Bob, 'hi'\n"
	if got != want {
		t.Fatalf("Read after completing partial line = %q, want %q", got, want)
	}
}

func TestTailer_Truncation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "eqlog.txt")
	mustWrite(t, path, "old content that will be cleared\n")

	tl := New(path, 0)
	defer tl.Close()
	if _, err := tl.Read(); err != nil {
		t.Fatalf("initial Read: %v", err)
	}

	// A cleared/rotated log: same path, now much shorter.
	mustWrite(t, path, "fresh start\n")

	got, err := tl.Read()
	if err != nil {
		t.Fatalf("Read after truncation: %v", err)
	}
	if got != "fresh start\n" {
		t.Fatalf("Read after truncation = %q, want %q (stale content must not survive a reset)", got, "fresh start\n")
	}
	if st := tl.Stat(); st.Resets != 2 {
		t.Fatalf("Stat().Resets = %d, want 2 (initial open + truncation reset)", st.Resets)
	}
}

func TestTailer_Replacement(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "eqlog.txt")
	mustWrite(t, path, "original file content\n")

	tl := New(path, 0)
	defer tl.Close()
	if _, err := tl.Read(); err != nil {
		t.Fatalf("initial Read: %v", err)
	}

	// Replace the file at the same path with a brand-new one (different
	// inode/file-index) that happens to be the same size or larger — size
	// alone wouldn't catch this, only file identity does.
	if err := os.Remove(path); err != nil {
		t.Fatalf("removing original: %v", err)
	}
	mustWrite(t, path, "a completely different file\n")

	got, err := tl.Read()
	if err != nil {
		t.Fatalf("Read after replacement: %v", err)
	}
	if got != "a completely different file\n" {
		t.Fatalf("Read after replacement = %q, want only the new file's content, not concatenated with the old", got)
	}
}

func TestTailer_MissingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "does-not-exist.txt")
	tl := New(path, 0)
	defer tl.Close()
	if _, err := tl.Read(); err == nil {
		t.Fatal("Read of a missing file: want an error, got nil")
	}
}

// TestTailer_LargeLog_IncrementalReadIsFast is remediation plan Phase 2
// task 2.7: prove that appending a small amount to a large log makes a
// subsequent Read cost proportional to the new bytes, not to the file's
// total size — the actual mechanism behind the confirmed production
// failure (a nearly 1 GB officer log re-read from scratch on every poll).
func TestTailer_LargeLog_IncrementalReadIsFast(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping large-file benchmark in -short mode")
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "eqlog.txt")

	const targetSize = 100 * 1024 * 1024 // 100 MB — large enough to show the effect, small enough to keep the test fast
	line := "[Wed Sep 10 20:15:05 2026] Kuky tells the guild, 'ready when you are'\n"
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("creating large fixture: %v", err)
	}
	written := 0
	for written < targetSize {
		n, err := f.WriteString(line)
		if err != nil {
			t.Fatalf("writing fixture: %v", err)
		}
		written += n
	}
	_ = f.Close()

	tl := New(path, 0)
	defer tl.Close()

	start := time.Now()
	if _, err := tl.Read(); err != nil {
		t.Fatalf("initial full Read: %v", err)
	}
	fullReadElapsed := time.Since(start)

	// Append a small, realistic chunk — one new tell — the same kind of
	// growth a real poll tick sees.
	appended := "[Wed Sep 10 20:20:00 2026] Kuky tells you, 'high'\n"
	af, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("opening for append: %v", err)
	}
	if _, err := af.WriteString(appended); err != nil {
		t.Fatalf("appending: %v", err)
	}
	_ = af.Close()

	start = time.Now()
	got, err := tl.Read()
	if err != nil {
		t.Fatalf("incremental Read: %v", err)
	}
	incrementalElapsed := time.Since(start)

	if !strings.HasSuffix(got, appended) {
		t.Fatalf("incremental Read did not include the newly appended tell")
	}
	if len(got) != written+len(appended) {
		t.Fatalf("accumulated content length = %d, want %d", len(got), written+len(appended))
	}

	t.Logf("full read of %d bytes: %v; incremental read of %d new bytes: %v", written, fullReadElapsed, len(appended), incrementalElapsed)

	// The incremental read must be dramatically cheaper than a fresh full
	// read of the same total size — this is the whole point of the
	// tailer. Guard against flakiness on a slow/loaded CI machine by
	// comparing against the measured full-read cost (relative), not an
	// absolute wall-clock threshold.
	if incrementalElapsed > fullReadElapsed/4 {
		t.Fatalf("incremental read (%v) was not meaningfully faster than the full read (%v) — the tailer may be re-reading the whole file every call", incrementalElapsed, fullReadElapsed)
	}
}

func TestTailer_Path(t *testing.T) {
	tl := New("/some/path.txt", 0)
	if tl.Path() != "/some/path.txt" {
		t.Fatalf("Path() = %q", tl.Path())
	}
}

func TestTailer_InitialReadIsBoundedAndStartsOnCompleteLine(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "eqlog.txt")
	mustWrite(t, path, "old-one\nold-two\nnew-one\nnew-two\n")

	tl := New(path, 18)
	defer tl.Close()
	got, err := tl.Read()
	if err != nil {
		t.Fatal(err)
	}
	if got != "new-one\nnew-two\n" {
		t.Fatalf("bounded Read = %q, want newest complete lines", got)
	}
}

func TestTailer_StatFieldsPopulated(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "eqlog.txt")
	content := "hello\n"
	mustWrite(t, path, content)

	tl := New(path, 0)
	defer tl.Close()
	if _, err := tl.Read(); err != nil {
		t.Fatalf("Read: %v", err)
	}
	st := tl.Stat()
	if st.Size != int64(len(content)) {
		t.Fatalf("Stat().Size = %d, want %d", st.Size, len(content))
	}
	if st.BytesRead != int64(len(content)) {
		t.Fatalf("Stat().BytesRead = %d, want %d", st.BytesRead, len(content))
	}
	if st.LastReadAt.IsZero() {
		t.Fatal("Stat().LastReadAt is zero after a successful Read")
	}
	if st.Path != path {
		t.Fatalf("Stat().Path = %q, want %q", st.Path, path)
	}
}

func TestTailer_CloseIsIdempotentAndSafeBeforeRead(t *testing.T) {
	tl := New(filepath.Join(t.TempDir(), "never-read.txt"), 0)
	if err := tl.Close(); err != nil {
		t.Fatalf("Close before any Read: %v", err)
	}
	if err := tl.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

// TestTailer_ConcurrentReadersDuringGrowth exercises the real call
// pattern in app.go: the announcement watcher and the live-bid poller
// each call Read() on the SAME Tailer from their own goroutine while the
// file keeps growing. Run with -race — the point of this test is to
// catch any data race, not to assert on returned content (which is
// inherently a race between the readers and the writer goroutine).
func TestTailer_ConcurrentReadersDuringGrowth(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "eqlog.txt")
	mustWrite(t, path, "start\n")

	tl := New(path, 0)
	defer tl.Close()

	done := make(chan struct{})
	var wg sync.WaitGroup

	// Writer: simulates the EQ client appending lines.
	wg.Add(1)
	go func() {
		defer wg.Done()
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			t.Errorf("opening for append: %v", err)
			return
		}
		defer f.Close()
		for i := 0; i < 100; i++ {
			if _, err := fmt.Fprintf(f, "line %d\n", i); err != nil {
				t.Errorf("appending: %v", err)
				return
			}
		}
	}()

	// Two concurrent readers, mirroring the announcement watcher + live-bid
	// poller both calling a shared Tailer's Read().
	for r := 0; r < 2; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-done:
					return
				default:
				}
				if _, err := tl.Read(); err != nil {
					t.Errorf("concurrent Read: %v", err)
					return
				}
			}
		}()
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(200 * time.Millisecond)
		close(done)
	}()

	wg.Wait()

	final, err := tl.Read()
	if err != nil {
		t.Fatalf("final Read: %v", err)
	}
	if !strings.HasSuffix(final, "line 99\n") {
		t.Fatalf("final Read = %q, missing the last written line", final)
	}
}

func TestTailer_ManySmallAppends(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "eqlog.txt")
	mustWrite(t, path, "")

	tl := New(path, 0)
	defer tl.Close()

	var want strings.Builder
	for i := 0; i < 200; i++ {
		line := fmt.Sprintf("line %d\n", i)
		want.WriteString(line)

		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			t.Fatalf("opening for append: %v", err)
		}
		if _, err := f.WriteString(line); err != nil {
			t.Fatalf("appending: %v", err)
		}
		_ = f.Close()

		got, err := tl.Read()
		if err != nil {
			t.Fatalf("Read at iteration %d: %v", i, err)
		}
		if got != want.String() {
			t.Fatalf("Read at iteration %d mismatched accumulated content", i)
		}
	}
}
