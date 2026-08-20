package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/jasonsoprovich/seekers-epgp-parser/internal/config"
	"github.com/jasonsoprovich/seekers-epgp-parser/internal/officerapi"
	"github.com/jasonsoprovich/seekers-epgp-parser/internal/parse"
)

// App holds the running application's state — just which log file the
// officer picked. Lives only in memory: this app never persists a log
// path across restarts, since the officer re-picks it each raid night
// anyway. Bid capture used to carry its own start-time/open-session state
// here too, but it's stateless now — see CaptureBids.
type App struct {
	ctx context.Context

	logPath string
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// --- Settings: log file selection ---

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
	}
	return a.logPath, nil
}

func (a *App) GetLogPath() string {
	return a.logPath
}

// --- Settings: seekers-tracker connection ---

func (a *App) GetSettings() (config.Settings, error) {
	return config.Load()
}

func (a *App) SaveSettings(serverURL string, apiKey string) error {
	return config.Save(config.Settings{ServerURL: serverURL, APIKey: apiKey})
}

func (a *App) officerClient() (*officerapi.Client, error) {
	s, err := config.Load()
	if err != nil {
		return nil, err
	}
	if s.ServerURL == "" || s.APIKey == "" {
		return nil, errors.New("set your server URL and API key in Settings first")
	}
	return officerapi.New(s.ServerURL, s.APIKey), nil
}

// TestConnection confirms the saved server URL + API key actually work by
// pulling the roster (the same call the Attendance/Bids submit buttons
// eventually validate names against) — the Settings screen's "did I set
// this up right" check.
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
// "/who guild" snapshot — a raid night can have several (start/mid/end
// checks), and the officer only ever wants the latest one to record right
// now, same as the sketch's single "Attendance" capture button implies.
func (a *App) CaptureAttendance() (AttendanceResult, error) {
	raw, err := a.readLog()
	if err != nil {
		return AttendanceResult{}, err
	}

	snapshots, warnings := parse.ParseAttendance(raw)
	if len(snapshots) == 0 {
		return AttendanceResult{Warnings: warnings}, errors.New("no \"/who guild\" snapshot found in the log — run /who guild in-game first")
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

	return rows, nil
}

// SubmitBids charges GP for exactly the rows the officer is left with
// after editing tiers/removing rows in the Bids tab (same "submit what's
// on screen" contract as SubmitAttendance) — one row per character/tier
// pair, so a multi-winner split (two of the same item dropped) is just
// two remaining rows.
func (a *App) SubmitBids(itemName string, entries []officerapi.BidEntry) (officerapi.BidsResponse, error) {
	client, err := a.officerClient()
	if err != nil {
		return officerapi.BidsResponse{}, err
	}
	return client.SubmitBids(a.ctx, officerapi.BidsRequest{
		ItemName: itemName,
		Entries:  entries,
	})
}

