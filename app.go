package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/github"

	"github.com/jasonsoprovich/seekers-epgp-parser/internal/config"
	"github.com/jasonsoprovich/seekers-epgp-parser/internal/eqlogs"
	"github.com/jasonsoprovich/seekers-epgp-parser/internal/officerapi"
	"github.com/jasonsoprovich/seekers-epgp-parser/internal/parse"
)

// updateRepo is this app's own GitHub repo — where build-windows.yml
// publishes tagged releases (an exe + a combined SHA256SUMS digest
// sidecar) for the updater below to check against.
const updateRepo = "jasonsoprovich/seekers-epgp-parser"

// App holds the running application's state: an in-memory cache of the
// selected log file, kept in sync with config.json (see ServiceStartup and
// SelectLogFile) so it survives restarts and rebuilds instead of forcing
// a re-pick every time the app relaunches; and a cache of the site's
// leader-tunable EPGP settings (PLAN.md §4i, task 1.6) — this app never
// hardcodes the EP cap, minimum attendance, or decay rates, it fetches
// them.
type App struct {
	app *application.App
	ctx context.Context

	logPath  string
	settings officerapi.Settings

	// Guards liveBidsCancel and the round-state fields below — Capture
	// Bids (starts a poller, opens a round), End Round and Submit (stop the
	// poller, close the round) are all Wails-bound methods JS can call
	// back-to-back, so the swap needs to be safe against that, not just the
	// ticking goroutine itself.
	liveBidsMu     sync.Mutex
	liveBidsCancel context.CancelFunc
	// The item a round is currently open for ("" = no round), its window
	// start, whether SubmitBids has finalized it (so the poller's stop path
	// doesn't clear a round the site should now keep as "resolved"), and a
	// log-file swap the active-character watcher wanted to make but deferred
	// because a round was live (applied when the round closes — swapping
	// mid-round would rewind the capture window onto a different file). All
	// under liveBidsMu.
	roundItem      string
	roundStart     time.Time
	roundResolved  bool
	pendingLogPath string
	// A lower bound on where the next capture window may start — bumped to
	// "now" whenever a round ends (Discard / Submit / End Round). Without it,
	// re-announcing the SAME item within parse.announcementSessionGap
	// (10 min) makes FindAnnouncementStart merge back into the finished
	// round and re-ingest all its bids (a real bug: hit repeatedly while
	// re-running cmd/simlog against the same log, and it would also happen
	// on a genuine same-item re-drop from the next boss).
	roundFloor time.Time

	// The active-character log watcher: when GameDir is set (not a
	// hand-picked file), polls for which eqlog_<char>_<server>.txt is being
	// written to right now and re-points logPath + the announcement watch
	// at it when the officer swaps characters mid-raid. Mirrors the
	// annCancel pattern below.
	activeLogMu     sync.Mutex
	activeLogCancel context.CancelFunc

	// The Bids-tab log watcher: spots the officer's own "<item> send tells"
	// line and emits "bids:announcement" so the frontend can auto-start a
	// round without them typing the item name. annLastSeen advances past
	// each emitted line so the same announcement never fires twice.
	annMu       sync.Mutex
	annCancel   context.CancelFunc
	annLastSeen time.Time

	// A cache of the site's distinct gp_ledger.item_name list, refreshed by
	// the announcement watcher. parse.DetectAnnouncement uses it to tell a
	// real "<item> send tells" from a "send tells" typed mid-sentence — an
	// exact match here accepts a name outright; everything else falls back
	// to the structural looks-like-an-item check. Best-effort: nil (a fetch
	// that never succeeded) just means the structural check stands alone.
	knownItemsMu sync.RWMutex
	knownItems   []string

	// Close-confirmation guard (post-live-test-1 LT-24). The Attendance and
	// Bids panels each report whether they hold work that hasn't been
	// submitted to the site (captured /who snapshots, a live/in-review bid
	// round); main.go's WindowClosing hook checks HasUnsavedWork and asks
	// before quitting. allowQuit is latched true once the officer confirms
	// "discard & quit" so the second close attempt goes straight through.
	attendanceUnsaved atomic.Bool
	bidsUnsaved       atomic.Bool
	allowQuit         atomic.Bool
}

// SetAttendanceUnsaved / SetBidsUnsaved are called by their panels whenever
// their unsent-work state changes. HasUnsavedWork / AllowQuit / SetAllowQuit
// are read/set by main.go's close hook.
func (a *App) SetAttendanceUnsaved(v bool) { a.attendanceUnsaved.Store(v) }
func (a *App) SetBidsUnsaved(v bool)       { a.bidsUnsaved.Store(v) }
func (a *App) HasUnsavedWork() bool        { return a.attendanceUnsaved.Load() || a.bidsUnsaved.Load() }
func (a *App) AllowQuit() bool             { return a.allowQuit.Load() }
func (a *App) SetAllowQuit(v bool)         { a.allowQuit.Store(v) }

func (a *App) snapshotKnownItems() []string {
	a.knownItemsMu.RLock()
	defer a.knownItemsMu.RUnlock()
	return a.knownItems
}

// refreshKnownItems pulls the site's item-name list into the cache.
// Best-effort — a failure leaves the previous snapshot in place.
func (a *App) refreshKnownItems() {
	client, err := a.officerClient()
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
	defer cancel()
	items, err := client.FetchItems(ctx)
	if err != nil || len(items) == 0 {
		return
	}
	a.knownItemsMu.Lock()
	a.knownItems = items
	a.knownItemsMu.Unlock()
}

type announcementEvent struct {
	ItemName    string `json:"itemName"`
	AnnouncedAt string `json:"announcedAt"`
}

func NewApp() *App {
	return &App{}
}

// ServiceStartup is Wails v3's replacement for v2's OnStartup(ctx) hook —
// called once the application is running, before any bound method can be
// invoked from the frontend. application.Get() is only valid from this
// point on (main.go's application.New call hasn't returned yet when this
// runs).
func (a *App) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	a.app = application.Get()
	a.ctx = ctx
	if s, err := config.Load(); err == nil {
		a.logPath = s.LogPath
		// If a game folder is configured, re-resolve the active character's
		// log on launch — the officer may have last raided on a different
		// character than the one saved in LogPath.
		if s.GameDir != "" && !s.ManualLogPath {
			if active, ok := a.resolveActiveLog(s.GameDir); ok {
				a.logPath = active.Path
				a.persistLogPath(active.Path)
			}
		}
	}
	// Follow character swaps if a game folder is configured, and watch for
	// "send tells" announcements right away if a log file is already known
	// (both respect their Settings toggles / preconditions).
	a.startActiveLogWatch()
	a.startAnnouncementWatch()
	// Best-effort, same as CheckForUpdate: no API key yet, or no network,
	// just means FetchGuildSettings() below (which every settings-dependent
	// tab should call before trusting a value) does the live fetch instead
	// of returning a warm cache.
	if client, err := a.officerClient(); err == nil {
		if settings, err := client.FetchSettings(a.ctx); err == nil {
			a.settings = settings
		}
	}

	// Wails v3's built-in updater (PLAN.md §11 Phase 13.2), replacing the
	// Phase 7 internal/updatecheck + minio/selfupdate DIY shim. Headless
	// (WindowNone): this app already has its own startup banner (App.tsx)
	// driving CheckForUpdate/InstallUpdate below, so the built-in update
	// window would just be a second, redundant UI. ChecksumAsset points at
	// the combined SHA256SUMS build-windows.yml publishes alongside the
	// exe — same "verify before swapping anything in" guarantee Phase 7.2
	// had, just backed by the framework's verifier instead of a hand-rolled
	// one.
	gh, err := github.New(github.Config{
		Repository:    updateRepo,
		ChecksumAsset: "SHA256SUMS",
	})
	if err != nil {
		return fmt.Errorf("configuring updater: %w", err)
	}
	if err := a.app.Updater.Init(updater.Config{
		CurrentVersion: strings.TrimPrefix(Version, "v"),
		Providers:      []updater.Provider{gh},
		Window:         updater.WindowNone,
	}); err != nil {
		return fmt.Errorf("configuring updater: %w", err)
	}

	return nil
}

// --- Settings ---

func (a *App) SelectLogFile() (string, error) {
	path, err := a.app.Dialog.OpenFile().
		SetTitle("Select your EverQuest log file").
		AddFilter("Log files (*.txt)", "*.txt").
		PromptForSingleSelection()
	if err != nil {
		return "", err
	}
	if path != "" {
		a.logPath = path
		// A hand-picked file wins over game-folder auto-detection: mark it
		// manual so startActiveLogWatch stands down and stops re-pointing
		// logPath on the officer.
		if s, err := config.Load(); err == nil {
			s.LogPath = path
			s.ManualLogPath = true
			_ = config.Save(s)
		}
		a.stopActiveLogWatch()
		// Re-point the announcement watcher at the new file.
		a.startAnnouncementWatch()
	}
	return a.logPath, nil
}

func (a *App) GetLogPath() string {
	return a.logPath
}

// GameDirInfo is what the Settings screen renders after the officer picks
// their EverQuest folder: the folder itself, every character log found
// under it, and which one the app is now following (the most recently
// written — the character they're currently playing).
type GameDirInfo struct {
	GameDir      string                `json:"gameDir"`
	Logs         []eqlogs.CharacterLog `json:"logs"`
	ActivePath   string                `json:"activePath"`
	ActiveChar   string                `json:"activeChar"`
	ActiveServer string                `json:"activeServer"`
}

// SelectGameDir asks for the EverQuest install folder (or its Logs
// subfolder), then auto-detects the active character's log under it — the
// PQ-Companion-style flow. From here on the app follows character swaps on
// its own (startActiveLogWatch); the officer never re-picks a file when
// they change toons for a raid. Clears the manual-file flag SelectLogFile
// may have set.
func (a *App) SelectGameDir() (GameDirInfo, error) {
	dir, err := a.app.Dialog.OpenFile().
		SetTitle("Select your EverQuest folder").
		CanChooseFiles(false).
		CanChooseDirectories(true).
		PromptForSingleSelection()
	if err != nil {
		return GameDirInfo{}, err
	}
	if dir == "" {
		return a.gameDirInfo(), nil // cancelled — report current state
	}

	logs, err := eqlogs.Discover(dir)
	if err != nil {
		return GameDirInfo{}, fmt.Errorf("reading %s: %w", dir, err)
	}
	if len(logs) == 0 {
		return GameDirInfo{}, fmt.Errorf("no eqlog_<character>_<server>.txt files found under %s — pick your EverQuest folder or its Logs folder", dir)
	}

	s, err := config.Load()
	if err != nil {
		s = config.Settings{}
	}
	s.GameDir = dir
	s.ManualLogPath = false
	if active, ok := eqlogs.Active(logs); ok {
		s.LogPath = active.Path
		a.logPath = active.Path
	}
	_ = config.Save(s)

	a.startActiveLogWatch()
	a.startAnnouncementWatch()
	return a.gameDirInfo(), nil
}

// DetectedLogs re-scans the configured game folder — backs the Settings
// character list's Refresh button. Empty (not an error) if no game folder
// is set yet.
func (a *App) DetectedLogs() (GameDirInfo, error) {
	s, err := config.Load()
	if err != nil || s.GameDir == "" {
		return GameDirInfo{Logs: []eqlogs.CharacterLog{}}, nil
	}
	if _, err := eqlogs.Discover(s.GameDir); err != nil {
		return GameDirInfo{}, err
	}
	return a.gameDirInfo(), nil
}

// gameDirInfo builds the current GameDirInfo from config + a fresh scan.
func (a *App) gameDirInfo() GameDirInfo {
	info := GameDirInfo{Logs: []eqlogs.CharacterLog{}}
	s, err := config.Load()
	if err != nil || s.GameDir == "" {
		return info
	}
	info.GameDir = s.GameDir
	logs, err := eqlogs.Discover(s.GameDir)
	if err != nil {
		return info
	}
	info.Logs = logs
	for _, l := range logs {
		if l.Path == a.logPath {
			info.ActivePath = l.Path
			info.ActiveChar = l.Character
			info.ActiveServer = l.Server
		}
	}
	return info
}

// resolveActiveLog returns the most-recently-written character log under
// gameDir. Pure lookup, no state changes — callers decide whether to
// switch to it.
func (a *App) resolveActiveLog(gameDir string) (eqlogs.CharacterLog, bool) {
	logs, err := eqlogs.Discover(gameDir)
	if err != nil {
		return eqlogs.CharacterLog{}, false
	}
	return eqlogs.Active(logs)
}

// persistLogPath best-effort writes logPath back to config (so a swap the
// watcher made survives a restart), leaving every other field alone.
func (a *App) persistLogPath(path string) {
	if s, err := config.Load(); err == nil {
		s.LogPath = path
		_ = config.Save(s)
	}
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

// SetAutoDetectBids toggles the Bids-tab log watcher that auto-starts a
// round when the officer announces "<item> send tells" in chat. Persisted,
// and applied immediately (starts/stops the watcher this session too).
func (a *App) SetAutoDetectBids(enabled bool) error {
	s, err := config.Load()
	if err != nil {
		s = config.Settings{}
	}
	s.AutoDetectBids = &enabled
	if err := config.Save(s); err != nil {
		return err
	}
	if enabled {
		a.startAnnouncementWatch()
	} else {
		a.stopAnnouncementWatch()
	}
	return nil
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
	_ = a.app.Browser.OpenURL(officerapi.ServerURL + "/epgp/app-key")
}

// --- Updates ---

// UpdateInfo wraps the built-in updater's Check result into what the
// startup "you're on an old build" banner (App.tsx) needs — mirrors the
// Phase 7 updatecheck.Info shape so the frontend didn't need reworking
// past its import path.
type UpdateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Available bool   `json:"available"`
	URL       string `json:"url"`
}

// CheckForUpdate compares this build's embedded Version against the
// repo's latest GitHub release, for the startup "you're on an old build"
// banner. Errors here (no network, GitHub unreachable) are non-fatal to
// the rest of the app — the frontend just skips showing a banner. An
// unversioned "dev" build never reports an update available — there's
// nothing meaningful to compare a local build against.
func (a *App) CheckForUpdate() (UpdateInfo, error) {
	info := UpdateInfo{Current: Version}
	if Version == "" || Version == "dev" {
		return info, nil
	}

	rel, err := a.app.Updater.Check(a.ctx)
	if err != nil {
		return info, err
	}
	if rel == nil {
		return info, nil
	}

	url, _ := rel.Metadata["github.release.htmlURL"].(string)
	info.Available = true
	info.Latest = rel.Version
	info.URL = url
	return info, nil
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
	_ = a.app.Browser.OpenURL(url)
}

// InstallUpdate downloads and verifies the release CheckForUpdate already
// found (DownloadAndInstall — digest checked before anything is staged,
// same "verify before swapping anything in" guarantee Phase 7.2 had), then
// Restart spawns a helper process to swap the staged download into place
// and relaunch, quitting this process itself. Config lives outside the
// binary (os.UserConfigDir(), PLAN.md §7 Phase 7.3) so the swap can't
// touch the officer's saved API key or log path.
func (a *App) InstallUpdate() error {
	if err := a.app.Updater.DownloadAndInstall(a.ctx); err != nil {
		return err
	}
	return a.app.Updater.Restart(a.ctx)
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

// SubmitManualBid records a bid round the parser never captured — a tell
// missed, or the app not running when the item dropped. It sends the same
// payload SubmitBids does, but stamps every entry with the officer-supplied
// occurredAt and runs none of the live-round bookkeeping
// (roundItem/stopLiveBidPush) — there was no live round. Goes through
// SubmitBidsChecked, so an item already recorded near this time comes back
// as resp.Duplicate (with a message) rather than an error; the frontend
// then offers "Record anyway", which resubmits with confirmDuplicate=true.
func (a *App) SubmitManualBid(itemName, occurredAt, note string, entries []officerapi.BidEntry, confirmDuplicate bool) (officerapi.BidsResponse, error) {
	client, err := a.officerClient()
	if err != nil {
		return officerapi.BidsResponse{}, err
	}
	stamped := make([]officerapi.BidEntry, len(entries))
	for i, e := range entries {
		e.OccurredAt = occurredAt
		stamped[i] = e
	}
	return client.SubmitBidsChecked(a.ctx, officerapi.BidsRequest{
		ItemName:         itemName,
		Entries:          stamped,
		Note:             note,
		ConfirmDuplicate: confirmDuplicate,
	})
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

// latestPreferClosed returns the most recent snapshot, preferring one that
// closed with a "There are N players" footer — an unclosed block's name
// list is still usable but less trustworthy, so it's only chosen when
// every snapshot is unclosed. `snaps` must be non-empty.
func latestPreferClosed(snaps []parse.AttendanceSnapshot) parse.AttendanceSnapshot {
	for i := len(snaps) - 1; i >= 0; i-- {
		if !snaps[i].Unclosed {
			return snaps[i]
		}
	}
	return snaps[len(snaps)-1]
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

	latest := latestPreferClosed(snapshots)

	// The followed log holds months of history — every `/who <name>` the
	// officer ever ran is a "block". CaptureAttendance only ever returns the
	// single latest snapshot, so a warning about some unrelated block from
	// June is pure noise. Keep only warnings for the block we're actually
	// handing back (they're all prefixed with its RFC3339 timestamp).
	sel := latest.OccurredAt.Format(time.RFC3339)
	relevant := make([]string, 0, 1)
	for _, w := range warnings {
		if strings.Contains(w, sel) {
			relevant = append(relevant, w)
		}
	}

	return AttendanceResult{
		OccurredAt: latest.OccurredAt.Format(time.RFC3339),
		Zone:       latest.Zone,
		Names:      latest.Names,
		Warnings:   relevant,
	}, nil
}

// defaultAttendanceLookbackHours bounds ListAttendanceSnapshots when the
// caller doesn't pass a window — the followed log holds months of "/who"
// blocks and the officer usually only cares about tonight's. The frontend
// lets them widen it (doing attendance the next day, a weekend quest
// timestamp) up to maxAttendanceLookbackHours.
const (
	defaultAttendanceLookbackHours = 12
	maxAttendanceLookbackHours     = 72
)

// ListAttendanceSnapshots returns every "/who" / "/who guild" block in the
// followed log from the last `lookbackHours` (0 -> default 12h, clamped to
// [1, 72]), newest first, each as its own AttendanceResult. This backs the
// Attendance tab's multi-capture workflow (post-live-test-1 LT-21/LT-22):
// an officer captures at the start, middle, and end of a raid, keeps them
// all on screen, then assigns and submits the ones they want after the
// raid instead of mid-fight. Deduped by occurredAt; per-block warnings
// attached to their block.
func (a *App) ListAttendanceSnapshots(lookbackHours int) ([]AttendanceResult, error) {
	raw, err := a.readLog()
	if err != nil {
		return nil, err
	}
	snapshots, warnings := parse.ParseAttendance(raw)
	if len(snapshots) == 0 {
		return []AttendanceResult{}, errors.New("no \"/who\" or \"/who guild\" snapshot found in the log — run one of those in-game first")
	}

	if lookbackHours <= 0 {
		lookbackHours = defaultAttendanceLookbackHours
	}
	if lookbackHours > maxAttendanceLookbackHours {
		lookbackHours = maxAttendanceLookbackHours
	}
	cutoff := time.Now().Add(-time.Duration(lookbackHours) * time.Hour)
	out := make([]AttendanceResult, 0, 8)
	seen := map[string]bool{}
	for i := len(snapshots) - 1; i >= 0; i-- {
		s := snapshots[i]
		if s.OccurredAt.Before(cutoff) {
			break
		}
		sel := s.OccurredAt.Format(time.RFC3339)
		if seen[sel] {
			continue
		}
		seen[sel] = true

		relevant := make([]string, 0)
		for _, w := range warnings {
			if strings.Contains(w, sel) {
				relevant = append(relevant, w)
			}
		}
		out = append(out, AttendanceResult{
			OccurredAt: sel,
			Zone:       s.Zone,
			Names:      s.Names,
			Warnings:   relevant,
		})
	}
	return out, nil
}

// ParseAttendanceText is CaptureAttendance for text the officer pastes in
// rather than the followed log file — the Manual Attendance form's "paste a
// chunk of logs" path (a player-run quest's attendance reaches an officer
// as a copied log snippet, not a /who the app was running for). Same
// parser, same AttendanceResult shape. Unlike CaptureAttendance it merges
// the names from EVERY "/who" block in the paste (deduped, first spelling
// kept) rather than taking only the latest — a pasted snippet may hold two
// or three checks and the officer wants everyone who was present — while
// still reporting the latest block's time and zone. Every name stays
// editable in the form before submit.
func (a *App) ParseAttendanceText(raw string) (AttendanceResult, error) {
	snapshots, warnings := parse.ParseAttendance(raw)
	if warnings == nil {
		warnings = []string{}
	}
	if len(snapshots) == 0 {
		return AttendanceResult{Warnings: warnings}, errors.New("no \"/who\" or \"/who guild\" block found in the pasted text — paste the output of a /who the officer ran in-game")
	}

	// If any block closed cleanly, merge only the closed ones — a stray
	// unclosed fragment in the paste shouldn't add phantom names. If every
	// block is unclosed, merge them all (that's all the officer has).
	anyClosed := false
	for _, s := range snapshots {
		if !s.Unclosed {
			anyClosed = true
			break
		}
	}

	seen := map[string]bool{}
	names := []string{}
	for _, s := range snapshots {
		if anyClosed && s.Unclosed {
			continue
		}
		for _, n := range s.Names {
			key := strings.ToLower(strings.TrimSpace(n))
			if key == "" || seen[key] {
				continue
			}
			seen[key] = true
			names = append(names, n)
		}
	}

	latest := latestPreferClosed(snapshots)
	return AttendanceResult{
		OccurredAt: latest.OccurredAt.Format(time.RFC3339),
		Zone:       latest.Zone,
		Names:      names,
		Warnings:   warnings,
	}, nil
}

// SubmitAttendance sends exactly the names the officer is left with after
// editing/removing rows in the Attendance tab — same "submit what's on
// screen" contract as the Copy-to-clipboard button next to it, just to the
// site's ledger instead of the clipboard.
func (a *App) SubmitAttendance(activity string, occurredAt string, names []string, zone string, raidName string) (officerapi.AttendanceResponse, error) {
	client, err := a.officerClient()
	if err != nil {
		return officerapi.AttendanceResponse{}, err
	}
	return client.SubmitAttendance(a.ctx, officerapi.AttendanceRequest{
		Activity:       activity,
		OccurredAt:     occurredAt,
		CharacterNames: names,
		Zone:           zone,
		RaidName:       raidName,
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
	// The bidder sent "cancel my bid" at or after placing this bid. The row
	// is kept and flagged, not dropped — the officer decides whether to
	// remove it (they meant it) or keep it (they re-bid, or were joking).
	CancelRequested bool `json:"cancelRequested"`
}

// BidRound is the state of one bid round the Bids tab renders. While Live
// is true the poller re-emits this on "bids:round" every few seconds as
// tells arrive; End Round & Review (EndBidRound) freezes it (Live false)
// and the officer edits/submits from there. Wrapping the rows in a struct
// rather than returning a bare []BidRow also sidesteps the Wails "extra
// return value silently dropped" gotcha for the StartedAt/Live fields.
type BidRound struct {
	ItemName  string   `json:"itemName"`
	StartedAt string   `json:"startedAt"`
	Rows      []BidRow `json:"rows"`
	Live      bool     `json:"live"`
}

// buildRows turns a parse window into the review-table rows the frontend
// wants: every candidate tell in log order, later-from-the-same-character
// rows flagged Superseded (kept visible, not dropped, so the officer can
// override which one wins). Shared by CaptureBids, the live poller, and
// EndBidRound so all three produce byte-identical rows for the same log.
func buildRows(raw string, startAt, stopAt time.Time) []BidRow {
	candidates := parse.CaptureBids(raw, startAt, stopAt)

	// "cancel my bid" tells don't get their own row — pull them out and use
	// them to flag the bidder's most recent bid instead.
	bidCands := make([]parse.BidCandidate, 0, len(candidates))
	latestCancel := map[string]time.Time{}
	for _, c := range candidates {
		if c.Cancel && c.Tier == "" {
			k := strings.ToLower(c.CharacterName)
			if t, ok := latestCancel[k]; !ok || c.OccurredAt.After(t) {
				latestCancel[k] = c.OccurredAt
			}
			continue
		}
		bidCands = append(bidCands, c)
	}

	latest := parse.ResolveLatestPerCharacter(bidCands)

	rows := make([]BidRow, 0, len(bidCands))
	for _, c := range bidCands {
		k := strings.ToLower(c.CharacterName)
		best, ok := latest[k]
		superseded := ok && !best.OccurredAt.Equal(c.OccurredAt)
		// Flag only the character's active (latest) bid, and only if the
		// cancel came at or after they placed it — a cancel before a later
		// re-bid is stale.
		cancelRequested := false
		if ct, has := latestCancel[k]; has && !superseded && !ct.Before(c.OccurredAt) {
			cancelRequested = true
		}
		rows = append(rows, BidRow{
			CharacterName:   c.CharacterName,
			OccurredAt:      c.OccurredAt.Format(time.RFC3339),
			Tier:            c.Tier,
			Ambiguous:       c.Ambiguous,
			RawMessage:      c.RawMessage,
			Superseded:      superseded,
			CancelRequested: cancelRequested,
		})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].OccurredAt < rows[j].OccurredAt })
	return rows
}

// CaptureBids opens a live round: name the item, click once (or let the
// "send tells" watcher do it), and the round starts tracking.
//
// announcedAt is the RFC3339 timestamp of the specific "<item> send tells"
// line the watcher detected (empty when the officer clicked Capture Bids by
// hand). When set, it IS the window start — trusting the exact line the
// watcher found, rather than re-deriving with parse.FindAnnouncementStart,
// which merges announcements within a 10-min gap and so would fold a
// re-announcement back into a just-finished round. The manual path still
// uses FindAnnouncementStart. Either way the start is clamped to roundFloor
// (bumped every time a round ends) so a finished round's bids can't leak
// into the next one.
//
// From there the poller both pushes each new tell to the site's live view
// and re-emits the growing round to this app on "bids:round" until
// EndBidRound or SubmitBids. The returned BidRound is the first frame; it's
// marked Live.
func (a *App) CaptureBids(itemName string, announcedAt string) (BidRound, error) {
	if itemName == "" {
		return BidRound{}, errors.New("name the item you're collecting bids for")
	}
	raw, err := a.readLog()
	if err != nil {
		return BidRound{}, err
	}

	now := time.Now()
	var startAt time.Time
	if announcedAt != "" {
		if t, perr := time.Parse(time.RFC3339, announcedAt); perr == nil {
			startAt = t
		}
	}
	if startAt.IsZero() {
		s, ok := parse.FindAnnouncementStart(raw, itemName, now)
		if !ok {
			return BidRound{}, fmt.Errorf("no %q \"send tells\" announcement found in your log — say it in guild chat first, or check the item name spelling", itemName)
		}
		startAt = s
	}
	a.liveBidsMu.Lock()
	if !a.roundFloor.IsZero() && startAt.Before(a.roundFloor) {
		startAt = a.roundFloor
	}
	a.liveBidsMu.Unlock()

	// Switching items mid-session: clear the previous round off the site
	// unless it was already finalized (SubmitBids left it "resolved" for
	// members to review — Phase 16; the DO also sweeps this officer's
	// resolved rounds when the new item's first bid pushes).
	a.liveBidsMu.Lock()
	prevItem, prevResolved := a.roundItem, a.roundResolved
	a.roundItem = itemName
	a.roundStart = startAt
	a.roundResolved = false
	a.liveBidsMu.Unlock()
	if prevItem != "" && prevItem != itemName && !prevResolved {
		a.clearLiveBids(prevItem)
	}

	// PLAN.md §15 / Phase 12 task 12.3: from here on, push each
	// newly-detected tell for this item to the site's live view, and
	// re-emit the round locally, until EndBidRound or SubmitBids stops it.
	a.startLiveBidPush(itemName, startAt)

	return BidRound{
		ItemName:  itemName,
		StartedAt: startAt.Format(time.RFC3339),
		Rows:      buildRows(raw, startAt, now),
		Live:      true,
	}, nil
}

// EndBidRound stops the live poller and returns one last, frozen scan for
// the officer to edit and submit. It does NOT clear the site's round — the
// bids stay visible on /live-bids while the officer picks a winner, and
// SubmitBids then flips that round to "resolved" (Phase 16). If the officer
// abandons the round instead, DiscardBidRound clears it, or the DO's idle
// sweep drops it after ~5 min. Idempotent-ish: with no round open it just
// returns an empty, non-live BidRound.
func (a *App) EndBidRound() (BidRound, error) {
	a.liveBidsMu.Lock()
	item, start := a.roundItem, a.roundStart
	a.roundFloor = time.Now() // this round is done collecting — a later re-announce is a new round
	a.liveBidsMu.Unlock()

	a.stopLiveBidPush()

	if item == "" {
		return BidRound{Rows: []BidRow{}}, nil
	}
	raw, err := a.readLog()
	if err != nil {
		return BidRound{ItemName: item, StartedAt: start.Format(time.RFC3339), Rows: []BidRow{}}, err
	}
	return BidRound{
		ItemName:  item,
		StartedAt: start.Format(time.RFC3339),
		Rows:      buildRows(raw, start, time.Now()),
		Live:      false,
	}, nil
}

// DiscardBidRound throws away the current round without recording it —
// clears it off the site's live view and drops local round state. Wired to
// the Bids tab's "Discard" button.
func (a *App) DiscardBidRound() {
	a.liveBidsMu.Lock()
	item := a.roundItem
	a.roundItem = ""
	a.roundResolved = false
	a.roundFloor = time.Now() // don't let a re-announce re-ingest this round's bids
	a.liveBidsMu.Unlock()
	a.stopLiveBidPush()
	if item != "" {
		a.clearLiveBids(item)
	}
	a.applyPendingLogSwap()
}

// SubmitBids records every remaining row from the Bids tab as a bid (won
// or lost) and charges GP to whichever one is flagged as the winner —
// exactly one entry must have IsWinner set, which the frontend's
// "Determine Winner" (tier first, then priority) picks by default but the
// officer can override before calling this.
//
// The site rejects a same-item finalize within 12h of an existing one as a
// likely double-click (409). When confirmDuplicate is false that comes
// back as resp.Duplicate=true + resp.DuplicateMessage with a nil error, so
// the Bids tab can show "Record anyway"; calling again with
// confirmDuplicate=true records it regardless (a boss really did drop the
// same item twice in one night).
func (a *App) SubmitBids(itemName string, entries []officerapi.BidEntry, confirmDuplicate bool) (officerapi.BidsResponse, error) {
	client, err := a.officerClient()
	if err != nil {
		return officerapi.BidsResponse{}, err
	}
	resp, err := client.SubmitBidsChecked(a.ctx, officerapi.BidsRequest{
		ItemName:         itemName,
		Entries:          entries,
		ConfirmDuplicate: confirmDuplicate,
	})
	if err == nil && !resp.Duplicate {
		a.liveBidsMu.Lock()
		a.roundItem = ""
		a.roundResolved = true
		a.roundFloor = time.Now() // finalized — a re-drop of this item is a fresh round
		a.liveBidsMu.Unlock()
		a.stopLiveBidPush()
		// Phase 16: leave the round on /live-bids, now flagged resolved, for
		// a review window rather than yanking it. The finalize route (POST
		// /api/officer/bids) no longer touches the DO at all, so this is the
		// only signal the live view gets. Send the WHOLE reviewed bid list,
		// not just the winner(s), so the dimmed card keeps showing who bid
		// what — the officer's own edits/removals in the review table are
		// exactly what members should see as the final record.
		resolveBids := make([]officerapi.ResolveLiveBidEntry, 0, len(entries))
		for _, e := range entries {
			resolveBids = append(resolveBids, officerapi.ResolveLiveBidEntry{
				CharacterName: e.CharacterName,
				Tier:          e.Tier,
				OccurredAt:    e.OccurredAt,
				IsWinner:      e.IsWinner,
			})
		}
		bg, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = client.ResolveLiveBids(bg, itemName, eqlogs.CharacterFromPath(a.logPath), resolveBids)
		cancel()
		a.applyPendingLogSwap()
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

// clearLiveBids removes an item's round from the site's live view,
// best-effort with its own short-lived context (callers may be tearing down
// and have already cancelled a.ctx).
func (a *App) clearLiveBids(itemName string) {
	client, err := a.officerClient()
	if err != nil {
		return
	}
	bg, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_ = client.ClearLiveBids(bg, itemName)
	cancel()
}

// ServiceShutdown is Wails v3's optional teardown hook (services.go). If the
// officer quits mid-collection — before Submit resolved the round — clear it
// off the site so /live-bids doesn't show a dead round until the idle sweep.
// A round already resolved by Submit is left alone (members are reviewing
// it).
func (a *App) ServiceShutdown() error {
	a.liveBidsMu.Lock()
	item, resolved := a.roundItem, a.roundResolved
	a.liveBidsMu.Unlock()
	if item != "" && !resolved {
		a.clearLiveBids(item)
	}
	return nil
}

// startAnnouncementWatch (re)starts the background goroutine that polls the
// selected log for the officer's own "<item> send tells" line and emits
// "bids:announcement" for the frontend to auto-start a round. No-op if no
// log file is selected or the AutoDetectBids setting is off. Only ever
// looks at *new* lines (after the moment it starts), so a "send tells" the
// officer said before opening the app doesn't fire.
func (a *App) startAnnouncementWatch() {
	a.stopAnnouncementWatch()
	if a.logPath == "" {
		return
	}
	if s, err := config.Load(); err == nil && !s.AutoDetectBidsEnabled() {
		return
	}

	ctx, cancel := context.WithCancel(a.ctx)
	a.annMu.Lock()
	a.annCancel = cancel
	a.annLastSeen = time.Now()
	a.annMu.Unlock()

	go func() {
		// Prime the item-name cache once up front, then keep it fresh so a
		// newly-looted item becomes recognisable within a few minutes.
		go a.refreshKnownItems()

		ticker := time.NewTicker(4 * time.Second)
		defer ticker.Stop()
		const refreshEveryNTicks = 45 // ~3 min
		tick := 0
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			if tick++; tick%refreshEveryNTicks == 0 {
				go a.refreshKnownItems()
			}

			raw, err := a.readLog()
			if err != nil {
				continue
			}

			a.annMu.Lock()
			since := a.annLastSeen
			a.annMu.Unlock()

			item, at, ok := parse.DetectAnnouncement(raw, since, time.Now(), a.snapshotKnownItems())
			if !ok {
				continue
			}

			a.annMu.Lock()
			// Guard against a slow tick racing a stop/restart.
			if a.annCancel == nil {
				a.annMu.Unlock()
				return
			}
			a.annLastSeen = at
			a.annMu.Unlock()

			// A "<same item> send tells - last call" reminder while that
			// round is still open is NOT a new round — officers ping the
			// item two or three times over a 5-8 minute collection, and
			// "last call" often lands well after the opening call. As long
			// as roundItem is still set (the officer hasn't clicked End
			// Round / Submit / Clear), any same-item announcement is part of
			// the same round — swallow it, no time limit. annLastSeen was
			// advanced above so it won't re-fire. Once the round is closed
			// roundItem is "" and a fresh drop of the same item comes
			// through normally; a *different* item mid-round still raises the
			// Switch banner.
			a.liveBidsMu.Lock()
			current := a.roundItem
			a.liveBidsMu.Unlock()
			if isSameRoundItem(current, item) {
				continue
			}

			a.app.Event.Emit("bids:announcement", announcementEvent{
				ItemName:    item,
				AnnouncedAt: at.Format(time.RFC3339),
			})
		}
	}()
}

// isSameRoundItem reports whether a freshly-detected announcement is for
// the round that's already open. Exact match, or one name is a prefix of
// the other after normalising — so "<item> send tells last call" that
// `extractItemName` didn't fully clean still counts as the same round, not
// a new one. Empty `current` (no open round) is never a match.
func isSameRoundItem(current, detected string) bool {
	norm := func(s string) string {
		return strings.ToLower(strings.Join(strings.Fields(s), " "))
	}
	c, d := norm(current), norm(detected)
	if c == "" || d == "" {
		return false
	}
	return c == d || strings.HasPrefix(d, c+" ") || strings.HasPrefix(c, d+" ")
}

// stopAnnouncementWatch cancels the announcement watcher. Safe to call when
// none is running.
func (a *App) stopAnnouncementWatch() {
	a.annMu.Lock()
	defer a.annMu.Unlock()
	if a.annCancel != nil {
		a.annCancel()
		a.annCancel = nil
	}
}

// activeLogEvent is emitted on "log:active" whenever the followed character
// changes, so the Settings screen and the sidebar footer can update
// without polling.
type activeLogEvent struct {
	Path      string `json:"path"`
	Character string `json:"character"`
	Server    string `json:"server"`
}

// startActiveLogWatch (re)starts the goroutine that follows the officer's
// active character: every 10s it re-checks which eqlog under GameDir is
// being written to and, if that's changed, re-points logPath and the
// announcement watch at it. No-op unless a GameDir is configured and the
// officer hasn't overridden it with a hand-picked file (ManualLogPath).
//
// A swap is DEFERRED while a bid round is live — rewinding the capture
// window onto a different file mid-round would drop the round's bids. The
// pending path is stashed and applied by applyPendingLogSwap when the
// round closes.
func (a *App) startActiveLogWatch() {
	a.stopActiveLogWatch()

	s, err := config.Load()
	if err != nil || s.GameDir == "" || s.ManualLogPath {
		return
	}

	ctx, cancel := context.WithCancel(a.ctx)
	a.activeLogMu.Lock()
	a.activeLogCancel = cancel
	a.activeLogMu.Unlock()

	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}

			active, ok := a.resolveActiveLog(s.GameDir)
			if !ok || active.Path == a.logPath {
				continue
			}

			a.liveBidsMu.Lock()
			roundLive := a.roundItem != ""
			if roundLive {
				a.pendingLogPath = active.Path
			}
			a.liveBidsMu.Unlock()
			if roundLive {
				continue // apply once the round closes
			}

			a.switchActiveLog(active)
		}
	}()
}

// switchActiveLog re-points logPath at a newly-active character's log,
// persists it, restarts the announcement watch against it, and tells the
// frontend.
func (a *App) switchActiveLog(active eqlogs.CharacterLog) {
	a.logPath = active.Path
	a.persistLogPath(active.Path)
	a.startAnnouncementWatch()
	if a.app != nil {
		a.app.Event.Emit("log:active", activeLogEvent{
			Path:      active.Path,
			Character: active.Character,
			Server:    active.Server,
		})
	}
}

// applyPendingLogSwap performs a character-swap the watcher deferred
// because a round was live. Called from the round-closing paths
// (EndBidRound, SubmitBids). Under liveBidsMu already? No — callers must
// NOT hold it (switchActiveLog does its own work); they call this after
// clearing roundItem and releasing the lock.
func (a *App) applyPendingLogSwap() {
	a.liveBidsMu.Lock()
	path := a.pendingLogPath
	a.pendingLogPath = ""
	a.liveBidsMu.Unlock()
	if path == "" || path == a.logPath {
		return
	}
	s, err := config.Load()
	if err != nil || s.GameDir == "" {
		return
	}
	for _, l := range mustDiscover(s.GameDir) {
		if l.Path == path {
			a.switchActiveLog(l)
			return
		}
	}
}

// mustDiscover is eqlogs.Discover with the error swallowed to an empty
// slice — used where a scan failure just means "no swap this time".
func mustDiscover(gameDir string) []eqlogs.CharacterLog {
	logs, err := eqlogs.Discover(gameDir)
	if err != nil {
		return nil
	}
	return logs
}

// stopActiveLogWatch cancels the active-character watcher. Safe to call
// when none is running.
func (a *App) stopActiveLogWatch() {
	a.activeLogMu.Lock()
	defer a.activeLogMu.Unlock()
	if a.activeLogCancel != nil {
		a.activeLogCancel()
		a.activeLogCancel = nil
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
// Normally parse.CaptureBids is append-only across ticks for a fixed
// startAt against a growing log — each scan reproduces the previous tick's
// candidates as an exact prefix plus new ones at the end — so a count is
// enough to push just the new tail. If that invariant breaks (the log was
// truncated and rewritten under a live round — e.g. a fresh cmd/simlog run
// — so the scan is no longer a superset of what we pushed) the poller
// re-pushes from scratch; the DO de-dupes by character so that's safe.
//
// Best-effort throughout: a push failure (offline, key rejected) is
// silently skipped, same as the app's other best-effort background calls
// (FetchKnownItems, the startup settings fetch) — CaptureBids/SubmitBids
// stay the real record regardless of whether this side channel works.
// pushCursor is how many of the current scan's candidates the poller has
// already pushed, given the previous tick's count and the OccurredAt of the
// last candidate it pushed. Normally that's just prevPushed (append-only
// growth). It returns 0 when the scan is no longer an append-only superset
// of what we pushed — fewer candidates than we'd pushed, or a different
// candidate now sitting where the last-pushed one was — which means the log
// was truncated and rewritten under a live round (a fresh cmd/simlog run,
// say); re-pushing from scratch is safe since the DO de-dupes by character.
func pushCursor(candidates []parse.BidCandidate, prevPushed int, prevLastAt time.Time) int {
	if prevPushed > 0 && (len(candidates) < prevPushed || !candidates[prevPushed-1].OccurredAt.Equal(prevLastAt)) {
		return 0
	}
	return prevPushed
}

func (a *App) startLiveBidPush(itemName string, startAt time.Time) {
	a.stopLiveBidPush()

	ctx, cancel := context.WithCancel(a.ctx)
	a.liveBidsMu.Lock()
	a.liveBidsCancel = cancel
	a.liveBidsMu.Unlock()

	// Which of the officer's characters is capturing this round — the site
	// shows it as "collected by" (LT-07). Fixed for the round's lifetime: a
	// character swap is deferred while a round is live (startActiveLogWatch).
	capturedBy := eqlogs.CharacterFromPath(a.logPath)

	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		pushed := 0
		var lastPushedAt time.Time // OccurredAt of candidates[pushed-1] at the last push
		idleTicks := 0
		// The DO's live TTL is 90s, so a heartbeat every ~20s on a quiet
		// round is plenty of margin — and keeps per-key request volume low
		// when 1-10 officers are all polling at once during a raid
		// (PLAN.md §15). New tells still push immediately.
		const heartbeatEveryNIdleTicks = 4

		for {
			select {
			case <-ctx.Done():
				// Just stop polling. Whether the site's round is cleared,
				// resolved, or left to idle-sweep is decided by whichever
				// call stopped this poller — EndBidRound leaves it,
				// SubmitBids resolves it, DiscardBidRound / a round switch /
				// ServiceShutdown clear it. (Phase 16 — before this the
				// poller blanket-cleared on every stop path, which also
				// wiped a just-resolved round.)
				return
			case <-ticker.C:
			}

			raw, err := a.readLog()
			if err != nil {
				continue
			}
			now := time.Now()
			candidates := parse.CaptureBids(raw, startAt, now)

			// Re-emit the round to THIS app every tick (bids or not) so the
			// Bids tab's live table and bid count track reality without its
			// own timer. Local-only and independent of the site push below —
			// the officer's own view updates even with no API key set.
			a.app.Event.Emit("bids:round", BidRound{
				ItemName:  itemName,
				StartedAt: startAt.Format(time.RFC3339),
				Rows:      buildRows(raw, startAt, now),
				Live:      true,
			})

			client, err := a.officerClient()
			if err != nil {
				continue
			}

			pushed = pushCursor(candidates, pushed, lastPushedAt)

			if len(candidates) <= pushed {
				// Nothing new this tick — a quiet stretch of a real round,
				// not evidence the officer's gone. Heartbeat so the site's
				// idle TTL doesn't fire just because nobody's bid in a
				// while — but not every 5s tick (see heartbeatEveryNIdleTicks):
				// once right when it goes quiet, then every ~20s.
				idleTicks++
				if idleTicks%heartbeatEveryNIdleTicks == 1 {
					_ = client.HeartbeatLiveBids(ctx, itemName)
				}
				continue
			}

			idleTicks = 0
			for _, c := range candidates[pushed:] {
				_ = client.PushLiveBid(ctx, officerapi.LiveBidPushRequest{
					ItemName:            itemName,
					CharacterName:       c.CharacterName,
					Tier:                c.Tier,
					OccurredAt:          c.OccurredAt.Format(time.RFC3339),
					CapturedByCharacter: capturedBy,
				})
			}
			pushed = len(candidates)
			lastPushedAt = candidates[pushed-1].OccurredAt
		}
	}()
}
