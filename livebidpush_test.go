package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jasonsoprovich/seekers-epgp-parser/internal/officerapi"
)

func TestLivePushMailbox_Coalesces(t *testing.T) {
	m := newLivePushMailbox()

	// Nothing pending yet.
	if _, ok := m.take(); ok {
		t.Fatal("take() on an empty mailbox returned ok=true")
	}

	m.Put(livePushJob{itemName: "A", sig: "1"})
	m.Put(livePushJob{itemName: "A", sig: "2"})
	m.Put(livePushJob{itemName: "A", sig: "3"})

	job, ok := m.take()
	if !ok {
		t.Fatal("take() after three Puts returned ok=false")
	}
	if job.sig != "3" {
		t.Fatalf("take() returned sig %q, want the LATEST (\"3\") — older jobs must be superseded, not queued", job.sig)
	}

	// Consumed — nothing left.
	if _, ok := m.take(); ok {
		t.Fatal("take() after the mailbox was already drained returned ok=true")
	}

	// The wake channel must never block a Put, even with no reader —
	// three rapid Puts above must not have deadlocked (the test reaching
	// this line at all proves it), and a fourth after take() must still
	// signal correctly.
	m.Put(livePushJob{itemName: "A", sig: "4"})
	select {
	case <-m.wake:
	default:
		t.Fatal("Put did not signal the wake channel")
	}
}

func TestLivePushMailbox_PeekNewer(t *testing.T) {
	m := newLivePushMailbox()

	if _, ok := m.peekNewer("anything"); ok {
		t.Fatal("peekNewer on an empty mailbox returned ok=true")
	}

	m.Put(livePushJob{itemName: "A", sig: "1"})
	job, ok := m.take() // simulate the delivery loop now holding job "1"
	if !ok || job.sig != "1" {
		t.Fatalf("take() = %+v, %v", job, ok)
	}

	// No newer job has arrived — peeking with the CURRENT sig must not
	// return one.
	if _, ok := m.peekNewer("1"); ok {
		t.Fatal("peekNewer found a \"newer\" job when none was put")
	}

	m.Put(livePushJob{itemName: "A", sig: "2"})
	newer, ok := m.peekNewer("1")
	if !ok {
		t.Fatal("peekNewer did not find the newly-put job")
	}
	if newer.sig != "2" {
		t.Fatalf("peekNewer returned sig %q, want %q", newer.sig, "2")
	}

	// It's consumed by peekNewer, same as take().
	if _, ok := m.peekNewer("2"); ok {
		t.Fatal("peekNewer returned a job twice")
	}
}

// fakeLiveBidsServer records every request made to the live-bids push and
// heartbeat routes and replies according to failUntilAttempt (1-indexed;
// 0 means never fail).
type fakeLiveBidsServer struct {
	mu       sync.Mutex
	requests []string // request path, in order

	failUntilAttempt int32 // requests before this attempt number get a 500
	attempt          int32
}

func newFakeLiveBidsServer(failUntilAttempt int32) *fakeLiveBidsServer {
	return &fakeLiveBidsServer{failUntilAttempt: failUntilAttempt}
}

func (f *fakeLiveBidsServer) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.requests = append(f.requests, r.URL.Path)
		f.mu.Unlock()

		n := atomic.AddInt32(&f.attempt, 1)
		if f.failUntilAttempt > 0 && n < f.failUntilAttempt {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"simulated failure"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}
}

func (f *fakeLiveBidsServer) pathsRequested() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.requests))
	copy(out, f.requests)
	return out
}

// withTestServerURL points officerapi.ServerURL at srv for the duration of
// the test and restores it afterward — officerapi.New reads the package
// var once at construction, same override mechanism as SEEKERS_TRACKER_URL
// for local dev (see internal/officerapi/client.go).
func withTestServerURL(t *testing.T, srv *httptest.Server) {
	t.Helper()
	prev := officerapi.ServerURL
	officerapi.ServerURL = srv.URL
	t.Cleanup(func() { officerapi.ServerURL = prev })
}

func waitForCondition(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !cond() {
		t.Fatalf("condition not met within %v", timeout)
	}
}

func TestRunLivePushDelivery_DeliversOnSuccess(t *testing.T) {
	srv := newFakeLiveBidsServer(0) // never fail
	ts := httptest.NewServer(srv.handler())
	defer ts.Close()
	withTestServerURL(t, ts)

	client := officerapi.New("test-key")
	mailbox := newLivePushMailbox()
	status := &livePushStatus{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go runLivePushDelivery(ctx, mailbox, status, client)

	mailbox.Put(livePushJob{
		itemName:   "Cloak of Flames",
		capturedBy: "Osui",
		entries:    []officerapi.LiveBidSnapshotEntry{{CharacterName: "Kuky", Tier: "High Bid"}},
		sig:        "sig-1",
	})

	waitForCondition(t, 2*time.Second, func() bool {
		return status.snapshot().LastDeliveredAt != ""
	})

	got := status.snapshot()
	if got.PendingRetry {
		t.Fatal("PendingRetry is true after a successful delivery")
	}
	if got.LastError != "" {
		t.Fatalf("LastError = %q after a successful delivery, want empty", got.LastError)
	}

	paths := srv.pathsRequested()
	if len(paths) != 1 || paths[0] != "/api/officer/live-bids/push" {
		t.Fatalf("requests = %v, want exactly one to the push endpoint", paths)
	}
}

func TestRunLivePushDelivery_HeartbeatOnlyJobHitsHeartbeatEndpoint(t *testing.T) {
	srv := newFakeLiveBidsServer(0)
	ts := httptest.NewServer(srv.handler())
	defer ts.Close()
	withTestServerURL(t, ts)

	client := officerapi.New("test-key")
	mailbox := newLivePushMailbox()
	status := &livePushStatus{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go runLivePushDelivery(ctx, mailbox, status, client)

	// entries == nil (the zero value) marks a heartbeat-only job — see
	// startLiveBidPush's idle-tick branch.
	mailbox.Put(livePushJob{itemName: "Cloak of Flames", sig: "hb-1"})

	waitForCondition(t, 2*time.Second, func() bool {
		return status.snapshot().LastDeliveredAt != ""
	})

	paths := srv.pathsRequested()
	if len(paths) != 1 || paths[0] != "/api/officer/live-bids/heartbeat" {
		t.Fatalf("requests = %v, want exactly one to the heartbeat endpoint", paths)
	}
}

// TestRunLivePushDelivery_MarksDeliveredOnlyAfterSuccess is remediation
// plan Phase 2 task 2.4's explicit requirement: "Mark a snapshot delivered
// only after success." The server fails every attempt, so the job must
// exhaust its retries and report PendingRetry/LastError — never
// LastDeliveredAt.
func TestRunLivePushDelivery_MarksDeliveredOnlyAfterSuccess(t *testing.T) {
	srv := newFakeLiveBidsServer(1000) // never reached within maxAttempts, so every attempt fails
	ts := httptest.NewServer(srv.handler())
	defer ts.Close()
	withTestServerURL(t, ts)

	client := officerapi.New("test-key")
	mailbox := newLivePushMailbox()
	status := &livePushStatus{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go runLivePushDelivery(ctx, mailbox, status, client)

	mailbox.Put(livePushJob{
		itemName:   "Cloak of Flames",
		capturedBy: "Osui",
		entries:    []officerapi.LiveBidSnapshotEntry{{CharacterName: "Kuky", Tier: "High Bid"}},
		sig:        "sig-fail",
	})

	waitForCondition(t, 6*time.Second, func() bool {
		return status.snapshot().PendingRetry
	})

	got := status.snapshot()
	if got.LastDeliveredAt != "" {
		t.Fatalf("LastDeliveredAt = %q, want empty — every attempt failed, nothing was delivered", got.LastDeliveredAt)
	}
	if got.LastError == "" {
		t.Fatal("LastError is empty after every attempt failed")
	}

	// All 3 (maxAttempts) attempts must have gone to the server — a
	// failure must not silently give up after one try.
	paths := srv.pathsRequested()
	if len(paths) != 3 {
		t.Fatalf("server received %d requests, want 3 (maxAttempts)", len(paths))
	}
}

func TestRunLivePushDelivery_RecoversAfterATransientFailure(t *testing.T) {
	srv := newFakeLiveBidsServer(2) // first attempt fails, second (and later) succeed
	ts := httptest.NewServer(srv.handler())
	defer ts.Close()
	withTestServerURL(t, ts)

	client := officerapi.New("test-key")
	mailbox := newLivePushMailbox()
	status := &livePushStatus{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go runLivePushDelivery(ctx, mailbox, status, client)

	mailbox.Put(livePushJob{
		itemName:   "Cloak of Flames",
		capturedBy: "Osui",
		entries:    []officerapi.LiveBidSnapshotEntry{{CharacterName: "Kuky", Tier: "High Bid"}},
		sig:        "sig-recovers",
	})

	waitForCondition(t, 4*time.Second, func() bool {
		return status.snapshot().LastDeliveredAt != ""
	})

	got := status.snapshot()
	if got.PendingRetry {
		t.Fatal("PendingRetry is true after the retry eventually succeeded")
	}
	if got.LastError != "" {
		t.Fatalf("LastError = %q after eventual success, want cleared", got.LastError)
	}
}

func TestRunLivePushDelivery_StopsOnContextCancel(t *testing.T) {
	srv := newFakeLiveBidsServer(0)
	ts := httptest.NewServer(srv.handler())
	defer ts.Close()
	withTestServerURL(t, ts)

	client := officerapi.New("test-key")
	mailbox := newLivePushMailbox()
	status := &livePushStatus{}
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		runLivePushDelivery(ctx, mailbox, status, client)
		close(done)
	}()

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("runLivePushDelivery did not return after its context was cancelled")
	}
}
