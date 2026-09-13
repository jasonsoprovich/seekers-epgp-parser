package main

import (
	"context"
	"sync"
	"time"

	"github.com/jasonsoprovich/seekers-epgp-parser/internal/officerapi"
)

// This file is remediation plan Phase 2 task 2.4: decouple delivering a
// live-bid snapshot to the site (a network call that can stall or fail)
// from ingesting the log (reading it and re-emitting the local "bids:round"
// event, which must stay fast regardless of network conditions). Before
// this, startLiveBidPush did both in the same sequential ticker loop, so a
// slow or hanging site connection delayed the officer's OWN live view of
// their bid round, not just the site's — exactly the kind of coupling that
// made a "nearly 1 GB log + a struggling connection" a compounding
// failure rather than two separate, contained ones.

// livePushJob is one thing the delivery goroutine may send: either a full
// snapshot push, or a bare heartbeat for the same round (entries == nil).
type livePushJob struct {
	itemName   string
	capturedBy string
	entries    []officerapi.LiveBidSnapshotEntry
	sig        string
}

// livePushMailbox hands the latest live-bid job from the ingestion loop to
// the delivery goroutine without letting either block the other. Only the
// newest job is ever kept — task 2.4's "bounded, coalescing
// latest-snapshot queue": a snapshot fully describes the round's current
// bids, so if a newer one arrives before an older one is even sent, the
// older one is simply superseded, not queued behind it.
type livePushMailbox struct {
	mu      sync.Mutex
	pending *livePushJob
	wake    chan struct{}
}

func newLivePushMailbox() *livePushMailbox {
	return &livePushMailbox{wake: make(chan struct{}, 1)}
}

// Put replaces whatever job is pending and wakes the delivery loop. Never
// blocks — the ingestion loop's cadence must never depend on how fast (or
// whether) delivery is keeping up.
func (m *livePushMailbox) Put(job livePushJob) {
	m.mu.Lock()
	m.pending = &job
	m.mu.Unlock()
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// take removes and returns whatever job is currently pending, if any.
func (m *livePushMailbox) take() (livePushJob, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pending == nil {
		return livePushJob{}, false
	}
	job := *m.pending
	m.pending = nil
	return job, true
}

// peekNewer returns the currently pending job (consuming it) only if one
// exists and it isn't the same job the delivery loop is already holding —
// used between retry attempts so a slow retry loop sends the freshest
// bids it has rather than stubbornly finishing a now-stale attempt.
func (m *livePushMailbox) peekNewer(currentSig string) (livePushJob, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pending == nil || m.pending.sig == currentSig {
		return livePushJob{}, false
	}
	job := *m.pending
	m.pending = nil
	return job, true
}

// livePushStatus is the delivery goroutine's observable state — backs
// LiveBidPushStatus (task 2.5): the Bids tab can show "last sent Xs ago" /
// "retrying — connection trouble" instead of the officer only finding out
// their bids never reached the site when a member says the board is empty.
type livePushStatus struct {
	mu               sync.Mutex
	lastDeliveredAt  time.Time
	lastDeliveredSig string
	pendingRetry     bool
	lastError        string
}

func (s *livePushStatus) markAttempting() {
	s.mu.Lock()
	s.pendingRetry = false
	s.mu.Unlock()
}

func (s *livePushStatus) markRetry(err error) {
	s.mu.Lock()
	s.pendingRetry = true
	s.lastError = err.Error()
	s.mu.Unlock()
}

func (s *livePushStatus) markDelivered(sig string) {
	s.mu.Lock()
	s.pendingRetry = false
	s.lastError = ""
	s.lastDeliveredAt = time.Now()
	s.lastDeliveredSig = sig
	s.mu.Unlock()
}

func (s *livePushStatus) snapshot() LiveBidPushStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := LiveBidPushStatus{PendingRetry: s.pendingRetry, LastError: s.lastError}
	if !s.lastDeliveredAt.IsZero() {
		out.LastDeliveredAt = s.lastDeliveredAt.Format(time.RFC3339)
	}
	return out
}

// runLivePushDelivery is the delivery goroutine: blocks until the mailbox
// has something, tries to send it with a short per-attempt deadline and a
// small capped number of retries, marks it delivered only on success, then
// goes back to waiting. ctx is the same one startLiveBidPush's caller
// cancels on EndBidRound/SubmitBids/DiscardBidRound/a round switch, so this
// goroutine's lifetime always matches the ingestion goroutine's.
func runLivePushDelivery(ctx context.Context, mailbox *livePushMailbox, status *livePushStatus, client *officerapi.Client) {
	const (
		attemptDeadline = 8 * time.Second // short: a live round polls every 5s, a push shouldn't be allowed to fall far behind that
		maxAttempts     = 3
		retryBackoff    = 1500 * time.Millisecond
	)
	for {
		select {
		case <-ctx.Done():
			return
		case <-mailbox.wake:
		}
		job, ok := mailbox.take()
		if !ok {
			continue
		}

		status.markAttempting()
		var lastErr error
		delivered := false
		for attempt := 1; attempt <= maxAttempts; attempt++ {
			if ctx.Err() != nil {
				return
			}
			// A fresher snapshot showed up while we were retrying — switch
			// to it instead of stubbornly finishing a now-stale send.
			if newer, has := mailbox.peekNewer(job.sig); has {
				job = newer
			}

			attemptCtx, cancel := context.WithTimeout(ctx, attemptDeadline)
			var err error
			if job.entries == nil {
				err = client.HeartbeatLiveBids(attemptCtx, job.itemName)
			} else {
				err = client.PushLiveBidSnapshot(attemptCtx, job.itemName, job.capturedBy, job.entries)
			}
			cancel()

			if err == nil {
				delivered = true
				break
			}
			lastErr = err
			if attempt < maxAttempts {
				select {
				case <-ctx.Done():
					return
				case <-time.After(retryBackoff):
				}
			}
		}

		if delivered {
			status.markDelivered(job.sig)
		} else if lastErr != nil {
			status.markRetry(lastErr)
		}
	}
}
