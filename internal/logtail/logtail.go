// Package logtail incrementally follows a growing EverQuest client log
// file instead of re-reading it from disk in full on every poll.
//
// A production officer log can approach 1 GB (confirmed production
// failure mode, remediation plan Phase 2). Before this package existed,
// every capture — the Attendance/Bids buttons, the "send tells"
// announcement watcher, and the live-bid push poller — called
// os.ReadFile on the whole file independently, several times a minute.
// Tailer keeps one accumulated in-memory copy per file and, after the
// first read, only ever does a seeked read of the bytes appended since
// the previous call: the cost of a poll tick becomes proportional to how
// much the officer's log grew since the last tick, not to the file's
// total size. Holding the accumulated content in memory (rather than
// re-reading it) is a deliberate trade of a bounded amount of RAM — well
// within what a modern desktop has to spare — for eliminating repeated
// full-file disk reads, which is what actually failed in production.
package logtail

import (
	"bytes"
	"errors"
	"io"
	"os"
	"sync"
	"time"
	"unsafe"
)

// Tailer follows one file. Safe for concurrent use — every exported
// method takes an internal lock, and Read returns an independent copy of
// the accumulated content so a caller never races the tailer's own
// buffer.
type Tailer struct {
	path string

	mu      sync.Mutex
	file    *os.File
	fi      os.FileInfo // identity of the currently-open file, for os.SameFile checks
	offset  int64       // bytes already read from the open file into content
	content []byte

	lastSize   int64
	lastReadAt time.Time
	resets     int
}

// New returns a Tailer for path. It doesn't open the file yet — the first
// Read call does — so constructing one for a character log that doesn't
// exist yet (the officer hasn't logged that toon in this session) isn't
// an error until something actually tries to read it.
func New(path string) *Tailer {
	return &Tailer{path: path}
}

// Path is the file this Tailer follows.
func (t *Tailer) Path() string {
	return t.path
}

// Stat is a snapshot of the tailer's state, for a diagnostics/status
// display (remediation plan Phase 2 task 2.5) — not needed for parsing.
type Stat struct {
	Path       string    `json:"path"`
	Size       int64     `json:"size"`
	BytesRead  int64     `json:"bytesRead"`
	Resets     int       `json:"resets"`
	LastReadAt time.Time `json:"lastReadAt"`
}

func (t *Tailer) Stat() Stat {
	t.mu.Lock()
	defer t.mu.Unlock()
	return Stat{
		Path:       t.path,
		Size:       t.lastSize,
		BytesRead:  t.offset,
		Resets:     t.resets,
		LastReadAt: t.lastReadAt,
	}
}

// Read returns the full accumulated content through the last completed
// newline. An in-progress trailing line stays buffered until a later read
// observes its newline, so parsers never act on a transient partial record.
// The first call, and any call after the file is truncated or replaced (a
// fresh cmd/simlog run, a log cleared at a server restart, the officer
// re-pointing SelectLogFile at a different file that happens to reuse the
// same path), does a full read from the start. Every other call reads
// only the bytes appended since the previous Read — a growing raid log
// costs a few bytes to poll, not the whole file.
//
// A truncation (the file got smaller than what's already been read) and a
// replacement (a different underlying file now sits at this path —
// os.SameFile compares the OS's own file identity, not path or mtime, so
// a same-second delete+recreate is still caught) both trigger a reset.
// Anything else is treated as ordinary growth.
func (t *Tailer) Read() (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	info, err := os.Stat(t.path)
	if err != nil {
		return "", err
	}

	needsReset := t.file == nil
	if t.fi != nil && (!os.SameFile(t.fi, info) || info.Size() < t.offset) {
		needsReset = true
	}

	if needsReset {
		if t.file != nil {
			_ = t.file.Close()
		}
		f, openErr := os.Open(t.path)
		if openErr != nil {
			return "", openErr
		}
		t.file = f
		t.fi = info
		t.offset = 0
		// A fresh nil slice, not content[:0] — content[:0] would keep the
		// old backing array and reuse its spare capacity for what gets
		// appended next, which would silently corrupt any string a
		// previous Read call already handed out (see the unsafe.String
		// note below). Starting from nil guarantees a brand-new array.
		t.content = nil
		t.resets++
	}

	if _, err := t.file.Seek(t.offset, io.SeekStart); err != nil {
		return "", err
	}
	appended, err := io.ReadAll(t.file)
	if err != nil {
		return "", err
	}
	if len(appended) > 0 {
		t.appendGrowing(appended)
		t.offset += int64(len(appended))
	}

	// Re-stat after the read: the file may have grown further between the
	// Stat above and now under a live raid log, and Stat()'s reported Size
	// should reflect what was actually captured, not a stale pre-read value.
	if info2, err := os.Stat(t.path); err == nil {
		t.lastSize = info2.Size()
	} else {
		t.lastSize = info.Size()
	}
	t.lastReadAt = time.Now()

	// A zero-copy view over the accumulated buffer, not a fresh copy — for
	// a large log, copying the whole thing on every poll tick would be
	// exactly the O(total size) cost this package exists to eliminate.
	// This is safe because appendGrowing only ever extends content's
	// length (never mutates bytes at an index a previously-returned string
	// already covers) and a reset always starts a brand-new backing array
	// rather than reusing one a live string might still reference.
	completeLen := bytes.LastIndexByte(t.content, '\n') + 1
	if completeLen == 0 {
		return "", nil
	}
	return unsafe.String(unsafe.SliceData(t.content), completeLen), nil
}

// appendGrowing appends b to t.content, always leaving meaningful spare
// capacity so the next several small appends (an ordinary poll tick's
// worth of new log lines) don't each force a full reallocation-and-copy
// of the whole accumulated buffer. Without explicit headroom, a single
// large initial read (the common case: the first Read of an
// already-substantial log) can land content at a tight-fitting capacity,
// which would otherwise make the very next append — however small —
// pay to copy the entire buffer.
func (t *Tailer) appendGrowing(b []byte) {
	needed := len(t.content) + len(b)
	if cap(t.content) < needed {
		growTo := cap(t.content) * 2
		if growTo < needed {
			growTo = needed
		}
		headroom := growTo / 4
		if headroom < 64*1024 {
			headroom = 64 * 1024
		}
		growTo += headroom
		fresh := make([]byte, len(t.content), growTo)
		copy(fresh, t.content)
		t.content = fresh
	}
	t.content = append(t.content, b...)
}

// Close releases the open file handle, if any. Safe to call more than
// once, and safe to call on a Tailer that never successfully read.
func (t *Tailer) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.file == nil {
		return nil
	}
	err := t.file.Close()
	t.file = nil
	return err
}

// ErrNoPath is returned by callers that wrap Tailer for a not-yet-selected
// log file — logtail itself never returns it (a Tailer always has a path
// once constructed).
var ErrNoPath = errors.New("no log file selected")
