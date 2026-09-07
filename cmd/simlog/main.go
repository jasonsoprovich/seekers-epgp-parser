// Command simlog replays a realistic loot-bid round into an EverQuest
// client log so the officer app's live capture path can be watched end to
// end without a raid: the "send tells" announcement auto-starts a round in
// the Bids tab, ~15 member tells trickle in over the following minute, and
// the site's /live-bids view mirrors them as they land.
//
// It only ever appends timestamped text to a file — no network, no sqlite,
// no app internals. Everything downstream (the announcement watcher, the
// live-bid poller, the Durable Object, the website) is the real thing.
//
//	go run ./cmd/simlog                         # ~/Downloads/EverQuest-sim, char "Osui"
//	go run ./cmd/simlog --bids 20 --interval 2s
//	go run ./cmd/simlog --who 3 --bids 0        # attendance only: 3 /who snapshots, capture the last
//	go run ./cmd/simlog --who 2                 # 2 /who snapshots, then the bid round
//	go run ./cmd/simlog --log ~/Downloads/testlogs.txt   # append to an existing file instead
//	go run ./cmd/simlog --switch-to Ammaru      # after the round, make the alt's log newest
//
// Point the app at --game-dir first (Settings → Select EverQuest Folder),
// with SEEKERS_TRACKER_URL set to a local wrangler dev instance.
package main

import (
	"flag"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// EQ client log timestamp: C ctime()/asctime(), space-padded day. Same
// layout as internal/parse.logTimeLayout (unexported there, restated here
// so this stays a zero-dependency command).
const logTimeLayout = "Mon Jan _2 15:04:05 2006"

// Real roster mains present in the local D1 seed with a player_id, so
// priorities resolve on both the app table and the site. Override with
// --names "A,B,C".
var defaultBidders = []string{
	"Rizy", "Darkclaw", "Ieaini", "Disen", "Theofonias", "Hoder", "Takkisina",
	"Kaalos", "Leighi", "Astrael", "Xasik", "Bode", "Grimrose", "Koramak",
	"Grokenspiel", "Krayziefoo", "Allrin", "Stonae", "Osui", "Tippy", "Winladar",
}

// Bid message shapes drawn from internal/parse/testdata/bids_sample.txt —
// %s is the item name. The parser has to cope with the tier before or
// after the item, hyphen-glued, ALL CAPS, numeric, and one-word.
var bidTemplates = []string{
	"high %s",
	"%s high",
	"High-%s",
	"high",
	"HIGH",
	"Hi",
	"Major",
	"%s major",
	"%s 100",
	"50",
	"medium",
	"slight",
	"slight %s",
	"%s HIGH",
	"high for %s",
}

// Off-topic tells that must NOT parse as bids (the "10 minutes" one is a
// real historical false positive — see tier.go's timeUnitWords).
var decoys = []struct{ who, msg string }{
	{"Katrinka", "I have a zoom board meeting starting in 10 minutes, so I need to log. No more bosses for me tonight."},
	{"Tabbie", "grats all on the drops"},
	{"Rora", "selos please"},
}

var warmupChatter = []string{
	"You say to your guild, 'clearing trash to the next named'",
	"Winladar tells the raid, 'CH rotation on the MT please'",
	"You say to your guild, 'named up, everyone in position'",
	"Astrael tells the group, 'oom, need a min'",
	"You have slain a Guardian of Seru!",
}

func main() {
	var (
		gameDir      = flag.String("game-dir", filepath.Join(home(), "Downloads", "EverQuest-sim"), "EverQuest folder to write eqlog_<char>_<server>.txt under")
		logFile      = flag.String("log", "", "append directly to this file instead of building a game-dir layout")
		character    = flag.String("character", "Osui", "the officer's active character (also the log's owner)")
		server       = flag.String("server", "pq.proj", "server shortname in the log filename")
		altCharacter = flag.String("alt-character", "Ammaru", "a second character to seed an older log for, so auto-detect has a choice")
		switchTo     = flag.String("switch-to", "", "after the round, write chatter to this character's log so it becomes the newest (tests the post-round swap)")
		item         = flag.String("item", "Soul Essence of Aten Ha Ra", "item being bid on")
		nBids        = flag.Int("bids", 15, "how many member bids to send")
		interval     = flag.Duration("interval", 3*time.Second, "average gap between bids (jittered ±1s)")
		warmup       = flag.Duration("warmup", 20*time.Second, "idle chatter before the announcement, so the watcher is armed")
		withDecoys   = flag.Bool("decoys", true, "interleave off-topic tells that must be ignored")
		whoCount     = flag.Int("who", 0, "emit this many /who guild snapshots first (each in a different zone with a slightly different roster) — for testing that Attendance captures only the latest. Use with --bids 0 for an attendance-only run.")
		namesCSV     = flag.String("names", "", "comma-separated bidder names (default: baked-in real roster)")
		appendMode   = flag.Bool("append", false, "keep the existing log contents (default: truncate it first, so each run is a clean raid — re-running without this used to make the parser re-ingest the previous run's announcement + bids)")
		dryRun       = flag.Bool("dry-run", false, "print lines instead of writing them")
	)
	flag.Parse()

	bidders := defaultBidders
	if strings.TrimSpace(*namesCSV) != "" {
		bidders = splitTrim(*namesCSV)
	}
	if len(bidders) == 0 {
		fatal("no bidder names")
	}

	// Resolve the target file and, in game-dir mode, lay out the install.
	var target string
	if *logFile != "" {
		target = expand(*logFile)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			fatal(err.Error())
		}
	} else {
		logsDir := filepath.Join(expand(*gameDir), "Logs")
		if err := os.MkdirAll(logsDir, 0o755); err != nil {
			fatal(err.Error())
		}
		target = filepath.Join(logsDir, fmt.Sprintf("eqlog_%s_%s.txt", *character, *server))
		touch(target)
		if *altCharacter != "" && *altCharacter != *character {
			alt := filepath.Join(logsDir, fmt.Sprintf("eqlog_%s_%s.txt", *altCharacter, *server))
			touch(alt)
			// Make the alt's log a couple hours stale so the active char wins.
			old := time.Now().Add(-2 * time.Hour)
			_ = os.Chtimes(alt, old, old)
		}
		fmt.Printf("game dir : %s\n", expand(*gameDir))
	}

	// Each run is a fresh raid by default — otherwise the parser re-scans
	// the whole file and folds a prior run's "send tells" + bids into the
	// new round (they merge inside parse.announcementSessionGap).
	if !*appendMode && !*dryRun {
		if err := os.WriteFile(target, nil, 0o644); err != nil {
			fatal(err.Error())
		}
	}

	mode := "truncated"
	if *appendMode {
		mode = "appending"
	}
	if *dryRun {
		mode = "dry-run"
	}
	w := &writer{path: target, dryRun: *dryRun}
	fmt.Printf("log file : %s  (%s)\ncharacter: %s\nitem     : %q\nbidders  : %d\n\n", target, mode, *character, *item, *nBids)

	if *whoCount > 0 {
		emitWhoRounds(w, bidders, *whoCount)
		time.Sleep(2 * time.Second)
	}

	if *nBids <= 0 {
		fmt.Println("\n>>> --bids 0 — attendance only. Capture it on the Attendance tab (it takes the LAST /who).")
		return
	}

	// Warm-up: prove non-bid lines don't trigger a round, and give the
	// officer time to have the Bids tab open.
	fmt.Printf("warming up for %s (idle chatter)…\n", *warmup)
	warmDeadline := time.Now().Add(*warmup)
	for i := 0; time.Now().Before(warmDeadline); i++ {
		w.line(warmupChatter[i%len(warmupChatter)])
		time.Sleep(4 * time.Second)
	}

	// The announcement — this is what auto-starts the round.
	fmt.Println("\n>>> announcing — the app's Bids tab should flip to LIVE now")
	w.line(fmt.Sprintf("You say to your guild, '%s send tells'", *item))
	time.Sleep(2 * time.Second)

	// The bids.
	supersedeAt := 0                // first bidder re-bids near the end
	ambiguousAt := min(7, *nBids-1) // one bare "10"
	lastCallAt := *nBids / 2

	for i := 0; i < *nBids; i++ {
		if i == lastCallAt {
			w.line(fmt.Sprintf("You say to your guild, '%s send tells - last call'", *item))
			time.Sleep(sleepJitter(*interval))
		}

		who := bidders[i%len(bidders)]
		var msg string
		switch i {
		case ambiguousAt:
			msg = "10" // Low Bid / Alt Loot — must land as "needs review"
		default:
			t := bidTemplates[i%len(bidTemplates)]
			if strings.Contains(t, "%s") {
				msg = fmt.Sprintf(t, *item)
			} else {
				msg = t
			}
		}
		w.line(fmt.Sprintf("%s tells you, '%s'", who, msg))

		if *withDecoys && i > 0 && i%4 == 0 {
			d := decoys[(i/4-1)%len(decoys)]
			w.line(fmt.Sprintf("%s tells you, '%s'", d.who, d.msg))
		}
		time.Sleep(sleepJitter(*interval))
	}

	// The first bidder changes their mind — should show a "superseded" badge.
	w.line(fmt.Sprintf("%s tells you, '%s actually low'", bidders[supersedeAt], *item))

	fmt.Println("\n>>> bids done — click End Round & Review in the app, then Determine Winner → Submit")

	if *switchTo != "" && *logFile == "" {
		time.Sleep(3 * time.Second)
		logsDir := filepath.Join(expand(*gameDir), "Logs")
		altPath := filepath.Join(logsDir, fmt.Sprintf("eqlog_%s_%s.txt", *switchTo, *server))
		aw := &writer{path: altPath, dryRun: *dryRun}
		for i := 0; i < 3; i++ {
			aw.line(fmt.Sprintf("You say to your guild, 'now playing %s'", *switchTo))
			time.Sleep(2 * time.Second)
		}
		fmt.Printf("\n>>> wrote to %s — it's now the newest log; after End Round the app should follow it to %s\n", altPath, *switchTo)
	}
}

type writer struct {
	path   string
	dryRun bool
}

func (w *writer) line(text string) {
	stamped := fmt.Sprintf("[%s] %s", time.Now().Format(logTimeLayout), text)
	fmt.Println("  " + stamped)
	if w.dryRun {
		return
	}
	f, err := os.OpenFile(w.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		fatal(err.Error())
	}
	defer f.Close()
	if _, err := f.WriteString(stamped + "\n"); err != nil {
		fatal(err.Error())
	}
}

var whoZones = []string{"Plane of Time A", "Ssraeshza Temple", "Sanctus Seru", "Vex Thal"}

// emitWhoRounds writes `count` /who-guild snapshots a few seconds apart,
// each in a different zone and with a slightly different roster (the raid
// grows as stragglers zone in). CaptureAttendance keeps only the LAST one,
// so a correct capture shows the final roster/zone — not the first, and
// not a merged total. Each block is self-consistent: its "There are N
// players" line matches the names listed, so no parse warning fires.
func emitWhoRounds(w *writer, roster []string, count int) {
	for r := 0; r < count; r++ {
		// Round 0 has the fewest; each later round adds a couple more names.
		n := len(roster) - (count-1-r)*2
		if n < 1 {
			n = 1
		}
		if n > len(roster) {
			n = len(roster)
		}
		names := roster[:n]
		zone := whoZones[r%len(whoZones)]

		fmt.Printf(">>> /who guild #%d — %d players in %s%s\n", r+1, len(names), zone,
			map[bool]string{true: "  (this is the one Attendance should capture)"}[r == count-1])
		// The zone-in line the parser now prefers over the /who footer.
		w.line(fmt.Sprintf("You have entered %s.", zone))
		w.line("Players on EverQuest:")
		w.line("---------------------------")
		for _, name := range names {
			w.line(fmt.Sprintf("[65 Warrior] %s (Human) <Seekers of Souls>", name))
		}
		w.line(fmt.Sprintf("There are %d players in %s.", len(names), zone))
		if r < count-1 {
			time.Sleep(4 * time.Second)
			w.line("You say to your guild, 'moving to next zone, straggler check'")
			time.Sleep(3 * time.Second)
		}
	}
}

func sleepJitter(avg time.Duration) time.Duration {
	j := time.Duration(rand.Int63n(int64(2*time.Second))) - time.Second
	d := avg + j
	if d < 250*time.Millisecond {
		d = 250 * time.Millisecond
	}
	return d
}

func touch(path string) {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		fatal(err.Error())
	}
	_ = f.Close()
	now := time.Now()
	_ = os.Chtimes(path, now, now)
}

func splitTrim(csv string) []string {
	var out []string
	for _, p := range strings.Split(csv, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func home() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return h
}

func expand(p string) string {
	if p == "~" {
		return home()
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(home(), p[2:])
	}
	return p
}

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, "simlog: "+msg)
	os.Exit(1)
}
