package main

import (
	"context"
	"errors"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/jasonsoprovich/seekers-epgp-parser/internal/parse"
)

// App holds the running application's state — which log file the officer
// picked, and (if a bid session is open) when it started. Both live only
// in memory: this app never persists a log path or session across
// restarts, since the officer re-picks/re-starts each raid night anyway.
type App struct {
	ctx context.Context

	logPath      string
	bidItemName  string
	bidStartedAt time.Time
	bidOpen      bool
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

// StartBidCapture opens a capture window for one item. The officer types
// the item name themselves rather than the app trying to detect a "send
// tells" trigger phrase — see internal/parse/bids.go's doc comment for why
// that's not just simpler but actually more correct.
func (a *App) StartBidCapture(itemName string) error {
	if itemName == "" {
		return errors.New("name the item you're collecting bids for")
	}
	if a.logPath == "" {
		return errors.New("no log file selected — use Settings to pick one first")
	}
	a.bidItemName = itemName
	a.bidStartedAt = time.Now()
	a.bidOpen = true
	return nil
}

func (a *App) IsBidCaptureOpen() bool {
	return a.bidOpen
}

func (a *App) CurrentBidItemName() string {
	return a.bidItemName
}

// StopBidCapture closes the window and returns every candidate bid seen
// since Start, in log order, with later-from-the-same-character rows
// marked Superseded (default) — never dropped, so the officer can override
// which one actually wins before submitting.
func (a *App) StopBidCapture() ([]BidRow, error) {
	if !a.bidOpen {
		return nil, errors.New("no bid capture is open")
	}
	raw, err := a.readLog()
	if err != nil {
		return nil, err
	}

	candidates := parse.CaptureBids(raw, a.bidStartedAt, time.Now())
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

	a.bidOpen = false
	a.bidItemName = ""
	return rows, nil
}

