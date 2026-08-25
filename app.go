package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/jasonsoprovich/seekers-epgp-parser/internal/config"
	"github.com/jasonsoprovich/seekers-epgp-parser/internal/officerapi"
	"github.com/jasonsoprovich/seekers-epgp-parser/internal/parse"
	"github.com/jasonsoprovich/seekers-epgp-parser/internal/updatecheck"
)

// App holds the running application's state: an in-memory cache of the
// selected log file, kept in sync with config.json (see startup and
// SelectLogFile) so it survives restarts and rebuilds instead of forcing
// a re-pick every time the app relaunches; and a cache of the site's
// leader-tunable EPGP settings (PLAN.md §4i, task 1.6) — this app never
// hardcodes the EP cap, minimum attendance, or decay rates, it fetches
// them.
type App struct {
	ctx context.Context

	logPath  string
	settings officerapi.Settings

	// Guards liveBidsCancel — Capture Bids (starts a poller) and Submit
	// (stops one) are both Wails-bound methods JS can call back-to-back,
	// so the swap needs to be safe against that, not just the ticking
	// goroutine itself.
	liveBidsMu     sync.Mutex
	liveBidsCancel context.CancelFunc
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	if s, err := config.Load(); err == nil {
		a.logPath = s.LogPath
	}
	// Best-effort, same as CheckForUpdate: no API key yet, or no network,
	// just means FetchGuildSettings() below (which every settings-dependent
	// tab should call before trusting a value) does the live fetch instead
	// of returning a warm cache.
	if client, err := a.officerClient(); err == nil {
		if settings, err := client.FetchSettings(a.ctx); err == nil {
			a.settings = settings
		}
	}
}

// --- Settings ---

func (a *App) SelectLogFile() (string, error) {
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select your EverQuest log file",
		Filters: []runtime.FileFilter{
			{DisplayName: "Log files (*.txt)", Pattern: "*.txt"},
		},
	})
	if err != nil {
		return "", err
	}
	if path != "" {
		a.logPath = path
		// Best-effort — a failed save here shouldn't block using the log
		// file for the rest of this session, just means it won't survive
		// a restart.
		if s, err := config.Load(); err == nil {
			s.LogPath = path
			_ = config.Save(s)
		}
	}
	return a.logPath, nil
}

func (a *App) GetLogPath() string {
	return a.logPath
}

func (a *App) GetSettings() (config.Settings, error) {
	return config.Load()
}

func (a *App) SaveSettings(apiKey string) error {
	s, err := config.Load()
	if err != nil {
		s = config.Settings{}
	}
	s.APIKey = apiKey
	return config.Save(s)
}

// FetchGuildSettings does a live re-fetch of the site's leader-tunable
// EPGP settings and updates the in-memory cache startup() seeded — "fetch
// at startup and re-validate at submit" (PLAN.md §4i, task 1.6). Nothing
// calls this before a submit yet (there's no threshold to check against
// until task 4.4's minimum-attendance pre-check lands), but the Settings
// tab calls it to show the officer the guild's current numbers, and it's
// the hook 4.4 attaches to rather than trusting a settings snapshot that
// might be from hours ago.
func (a *App) FetchGuildSettings() (officerapi.Settings, error) {
	client, err := a.officerClient()
	if err != nil {
		return officerapi.Settings{}, err
	}
	settings, err := client.FetchSettings(a.ctx)
	if err != nil {
		return officerapi.Settings{}, err
	}
	a.settings = settings
	return settings, nil
}

// OpenAppKeyPage opens the site's app-key generation page in the
// officer's default browser, so getting set up is "click this, paste the
// key back in" rather than typing a URL by hand.
func (a *App) OpenAppKeyPage() {
	runtime.BrowserOpenURL(a.ctx, officerapi.ServerURL+"/epgp/app-key")
}

// --- Updates ---

// CheckForUpdate compares this build's embedded Version against the
// repo's latest GitHub release, for the startup "you're on an old build"
// banner. Errors here (no network, GitHub unreachable) are non-fatal to
// the rest of the app — the frontend just skips showing a banner.
func (a *App) CheckForUpdate() (updatecheck.Info, error) {
	return updatecheck.Check(a.ctx, Version)
}

// OpenReleasePage opens a GitHub release page (from CheckForUpdate's
// Info.URL) in the officer's default browser, same pattern as
// OpenAppKeyPage. Kept as a fallback next to InstallUpdate — if the
// automatic swap fails (e.g. no write permission to the install
// directory), the officer can still download and run the new exe by
// hand.
func (a *App) OpenReleasePage(url string) {
	if url == "" {
		return
	}
	runtime.BrowserOpenURL(a.ctx, url)
}

// InstallUpdate downloads and verifies the latest release
// (updatecheck.Apply — SHA-256 checked before anything is swapped in),
// then relaunches: spawns a new process from the now-updated exe and
// quits this one. Config lives outside the binary (os.UserConfigDir(),
// PLAN.md §7 Phase 7.3) so the swap can't touch the officer's saved API
// key or log path.
func (a *App) InstallUpdate() error {
	if _, err := updatecheck.Apply(a.ctx); err != nil {
		return err
	}

	exePath, err := os.Executable()
	if err != nil {
		// Update applied but we can't relaunch automatically — not fatal,
		// the officer just reopens the app manually to pick up the swap.
		return nil
	}
	if err := exec.Command(exePath).Start(); err != nil {
		return nil
	}
	runtime.Quit(a.ctx)
	return nil
}

func (a *App) officerClient() (*officerapi.Client, error) {
	s, err := config.Load()
	if err != nil {
		return nil, err
	}
	if s.APIKey == "" {
		return nil, errors.New("paste your API key into Settings first")
	}
	return officerapi.New(s.APIKey), nil
}

// TestConnection confirms the saved API key actually works by pulling the
// roster (the same call the Attendance/Bids submit buttons eventually
// validate names against) — the Settings screen's "did I set this up
// right" check.
func (a *App) TestConnection() (int, error) {
	client, err := a.officerClient()
	if err != nil {
		return 0, err
	}
	characters, err := client.FetchCharacters(a.ctx)
	if err != nil {
		return 0, err
	}
	return len(characters), nil
}

// FetchKnownItems backs the Bids item-name field's autocomplete — every
// item_name the site's gp_ledger has ever charged GP for (see
// /api/officer/items). There's no separate items catalog; typing a new
// item just means it'll suggest itself for the next officer once this
// bid is submitted.
func (a *App) FetchKnownItems() ([]string, error) {
	client, err := a.officerClient()
	if err != nil {
		return nil, err
	}
	return client.FetchItems(a.ctx)
}

// FetchRoster backs the Main-character and Priority columns on both the
// Attendance and Bids tables — the frontend fetches this once and
// resolves each editable row's name against it live (client-side), so a
// typo'd name fixed in the table updates its Main/Priority immediately
// without another round trip.
func (a *App) FetchRoster() ([]officerapi.Character, error) {
	client, err := a.officerClient()
	if err != nil {
		return nil, err
	}
	return client.FetchCharacters(a.ctx)
}

// LinkCharacter resolves an Attendance/Bids "no match" name against the
// site roster: pass mainCharacterID to attach it as a new alt of that
// main, or nil to add it as a brand-new main. The returned Character gets
// merged into the frontend's already-fetched roster so the row resolves
// immediately, without a full FetchRoster round trip.
func (a *App) LinkCharacter(name string, mainCharacterID *int) (officerapi.Character, error) {
	client, err := a.officerClient()
	if err != nil {
		return officerapi.Character{}, err
	}
	return client.CreateCharacter(a.ctx, officerapi.CreateCharacterRequest{Name: name, MainCharacterID: mainCharacterID})
}

// --- Manual Entry ---

// PointValues wraps FetchPointValues' two lists into one Wails-friendly
// return — Wails bindings only carry a single value plus a trailing
// error, so a bare (ep, gp, error) signature silently drops gp from the
// generated TS binding.
type PointValues struct {
	EP []officerapi.PointValue `json:"ep"`
	GP []officerapi.PointValue `json:"gp"`
}

func (a *App) FetchPointValues() (PointValues, error) {
	client, err := a.officerClient()
	if err != nil {
		return PointValues{}, err
	}
	ep, gp, err := client.FetchPointValues(a.ctx)
	return PointValues{EP: ep, GP: gp}, err
}

func (a *App) SubmitManualEntry(req officerapi.ManualEntryRequest) error {
	client, err := a.officerClient()
	if err != nil {
		return err
	}
	return client.SubmitManualEntry(a.ctx, req)
}

// --- Browse ---

// LedgerPage wraps FetchLedger's (rows, hasNext) pair into one
// Wails-friendly return — same reason as PointValues above.
type LedgerPage struct {
	Rows    []officerapi.LedgerRow `json:"rows"`
	HasNext bool                   `json:"hasNext"`
}

func (a *App) FetchLedger(kind string, query string, page int) (LedgerPage, error) {
	client, err := a.officerClient()
	if err != nil {
		return LedgerPage{}, err
	}
	rows, hasNext, err := client.FetchLedger(a.ctx, kind, query, page)
	return LedgerPage{Rows: rows, HasNext: hasNext}, err
}

func (a *App) FetchTotals(query string) ([]officerapi.TotalsRow, error) {
	client, err := a.officerClient()
	if err != nil {
		return nil, err
	}
	return client.FetchTotals(a.ctx, query)
}

func (a *App) readLog() (string, error) {
	if a.logPath == "" {
		return "", errors.New("no log file selected — use Settings to pick one first")
	}
	data, err := os.ReadFile(a.logPath)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// --- Attendance ---

// AttendanceResult is what the frontend's Attendance tab renders into its
// editable table — see the app's sketch (Name/Timestamp column layout).
type AttendanceResult struct {
	OccurredAt string   `json:"occurredAt"`
	Zone       string   `json:"zone"`
	Names      []string `json:"names"`
	Warnings   []string `json:"warnings"`
}

// CaptureAttendance re-reads the log file and returns the MOST RECENT
// "/who" or "/who guild" snapshot (both produce the same "Players on
// EverQuest:" block parse.ParseAttendance reads) — a raid night can have
// several (start/mid/end checks), and the officer only ever wants the
// latest one to record right now, same as the sketch's single "Attendance"
// capture button implies.
func (a *App) CaptureAttendance() (AttendanceResult, error) {
	raw, err := a.readLog()
	if err != nil {
		return AttendanceResult{}, err
	}

	snapshots, warnings := parse.ParseAttendance(raw)
	if len(snapshots) == 0 {
		return AttendanceResult{Warnings: warnings}, errors.New("no \"/who\" or \"/who guild\" snapshot found in the log — run one of those in-game first")
	}

	latest := snapshots[len(snapshots)-1]
	return AttendanceResult{
		OccurredAt: latest.OccurredAt.Format(time.RFC3339),
		Zone:       latest.Zone,
		Names:      latest.Names,
		Warnings:   warnings,
	}, nil
}

// SubmitAttendance sends exactly the names the officer is left with after
// editing/removing rows in the Attendance tab — same "submit what's on
// screen" contract as the Copy-to-clipboard button next to it, just to the
// site's ledger instead of the clipboard.
func (a *App) SubmitAttendance(activity string, occurredAt string, names []string) (officerapi.AttendanceResponse, error) {
	client, err := a.officerClient()
	if err != nil {
		return officerapi.AttendanceResponse{}, err
	}
	return client.SubmitAttendance(a.ctx, officerapi.AttendanceRequest{
		Activity:       activity,
		OccurredAt:     occurredAt,
		CharacterNames: names,
	})
}

// --- Bids ---

// BidRow is one candidate bid for the frontend's editable review table.
type BidRow struct {
	CharacterName string `json:"characterName"`
	OccurredAt    string `json:"occurredAt"`
	Tier          string `json:"tier"`
	Ambiguous     bool   `json:"ambiguous"`
	RawMessage    string `json:"rawMessage"`
	Superseded    bool   `json:"superseded"` // an earlier bid from the same character, kept visible but not the default winner
}

// CaptureBids takes a snapshot: name the item, click once, done. It finds
// the most recent "<item> send tells" line the officer said themselves (at
// or before now) and treats that as the window start — see
// parse.FindAnnouncementStart — so there's no separate Start step to
// forget before bids start coming in. Every candidate tell in that window
// comes back, in log order, with later-from-the-same-character rows
// marked Superseded (default) — never dropped, so the officer can override
// which one actually wins before submitting.
func (a *App) CaptureBids(itemName string) ([]BidRow, error) {
	if itemName == "" {
		return nil, errors.New("name the item you're collecting bids for")
	}
	raw, err := a.readLog()
	if err != nil {
		return nil, err
	}

	now := time.Now()
	startAt, ok := parse.FindAnnouncementStart(raw, itemName, now)
	if !ok {
		return nil, fmt.Errorf("no %q \"send tells\" announcement found in your log — say it in guild chat first, or check the item name spelling", itemName)
	}

	candidates := parse.CaptureBids(raw, startAt, now)
	latest := parse.ResolveLatestPerCharacter(candidates)

	rows := make([]BidRow, 0, len(candidates))
	for _, c := range candidates {
		best, ok := latest[strings.ToLower(c.CharacterName)]
		superseded := ok && !best.OccurredAt.Equal(c.OccurredAt)
		rows = append(rows, BidRow{
			CharacterName: c.CharacterName,
			OccurredAt:    c.OccurredAt.Format(time.RFC3339),
			Tier:          c.Tier,
			Ambiguous:     c.Ambiguous,
			RawMessage:    c.RawMessage,
			Superseded:    superseded,
		})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].OccurredAt < rows[j].OccurredAt })

	// PLAN.md §15 / Phase 12 task 12.3: from this point on, push each
	// newly-detected tell for this item to the site's live view, until
	// Submit or the next Capture Bids call stops it.
	a.startLiveBidPush(itemName, startAt)

	return rows, nil
}

// SubmitBids records every remaining row from the Bids tab as a bid (won
// or lost) and charges GP to whichever one is flagged as the winner —
// exactly one entry must have IsWinner set, which the frontend's
// "Determine Winner" (tier first, then priority) picks by default but the
// officer can override before calling this.
func (a *App) SubmitBids(itemName string, entries []officerapi.BidEntry) (officerapi.BidsResponse, error) {
	client, err := a.officerClient()
	if err != nil {
		return officerapi.BidsResponse{}, err
	}
	resp, err := client.SubmitBids(a.ctx, officerapi.BidsRequest{
		ItemName: itemName,
		Entries:  entries,
	})
	if err == nil {
		// The finalize route itself clears the live DO's state — this just
		// stops the Go side from continuing to poll into a round that's
		// already done.
		a.stopLiveBidPush()
	}
	return resp, err
}

// stopLiveBidPush cancels any in-flight live-bid polling loop. Safe to
// call when none is running.
func (a *App) stopLiveBidPush() {
	a.liveBidsMu.Lock()
	defer a.liveBidsMu.Unlock()
	if a.liveBidsCancel != nil {
		a.liveBidsCancel()
		a.liveBidsCancel = nil
	}
}

// startLiveBidPush polls the log every few seconds for bid tells newly
// detected since the last poll (within the same [startAt, now) window
// CaptureBids itself scans) and pushes each one to the site's live-bids
// endpoint — PLAN.md §15 / Phase 12 task 12.3, giving the website's live
// view visibility into bids as they come in, before the officer finalizes.
// Cancels any previous poller first: naming a new item and clicking
// Capture Bids again implies the previous round is over, same reasoning
// the DO's own /push handler uses to start a fresh round server-side.
//
// Relies on parse.CaptureBids being deterministic and append-only across
// ticks for a fixed startAt against a growing log file — re-scanning
// always reproduces the previous tick's candidates as an exact prefix,
// plus any new ones at the end — so tracking only a count and pushing the
// new tail slice each tick is correct without needing to diff by value.
//
// Best-effort throughout: a push failure (offline, key rejected) is
// silently skipped, same as the app's other best-effort background calls
// (FetchKnownItems, the startup settings fetch) — CaptureBids/SubmitBids
// stay the real record regardless of whether this side channel works.
func (a *App) startLiveBidPush(itemName string, startAt time.Time) {
	a.stopLiveBidPush()

	ctx, cancel := context.WithCancel(a.ctx)
	a.liveBidsMu.Lock()
	a.liveBidsCancel = cancel
	a.liveBidsMu.Unlock()

	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		pushed := 0

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}

			raw, err := a.readLog()
			if err != nil {
				continue
			}
			candidates := parse.CaptureBids(raw, startAt, time.Now())
			if len(candidates) <= pushed {
				continue
			}

			client, err := a.officerClient()
			if err != nil {
				continue
			}
			for _, c := range candidates[pushed:] {
				_ = client.PushLiveBid(ctx, officerapi.LiveBidPushRequest{
					ItemName:      itemName,
					CharacterName: c.CharacterName,
					Tier:          c.Tier,
					OccurredAt:    c.OccurredAt.Format(time.RFC3339),
				})
			}
			pushed = len(candidates)
		}
	}()
}
