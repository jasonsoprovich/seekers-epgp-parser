# seekers-epgp-parser

Standalone desktop app (Wails: Go backend + React/TS frontend) an officer
runs on their own machine to parse EverQuest log files for raid attendance
and loot bids, then submit them to **seekers-tracker** (`../seekers-tracker`,
sibling repo — the guild's Next.js/Cloudflare website). Read that repo's
`CLAUDE.md` too; it has the full picture of how the repos connect and the
wider roadmap. This file is the app-specific half.

## ⚠ Read `../PLAN.md` first

**`../PLAN.md` (in the `seekers/` parent directory) is the authoritative
plan** for the current rebuild.

- **§11** is the execution plan — numbered phases, one task per commit, each
  tagged by repo. **Tasks tagged `[A]` are this repo.**
- **§1–§10** explain *why*. Consult them when a task needs context.
- Several findings there are counter-intuitive and were verified against the
  guild spreadsheet's actual formulas. Don't re-derive them from intuition.

Tasks that land in this repo, and where they're specified:

| Phase | Work here | Spec |
|---|---|---|
| 1.6 | Fetch settings (EP cap, min attendance, decay rates) from the API instead of hardcoding | §4i |
| 4.4 | Pre-check minimum attendance before submit; show "9 of 12 required" | §4h |
| 8 | Upgrade the existing update *check* into a real download-and-swap | §7 |
| 9.3 | In-game inventory export parser | §3, §9 |
| 13.3 | Push each detected bid tell live, pre-finalize | §15 |
| 14 | Wails v2 → v3 migration (after 2026-10-17 only) | §7 |

**The app is a thin capture client. The server owns the rules.** Its reason
to exist is reading large log files off local disk without uploading them.
Thresholds, point values, decay rates, and the EP cap are leader-adjustable
on the website and fetched from the API — never hardcoded here, or a rule
change would require an app release for every officer (§4i).

**This repo never owns database schema or migrations** — `seekers-tracker`
does. This app only talks to `/api/officer/*` over HTTP.

## Stack

- [Wails v2](https://wails.io) — Go backend (`app.go`, `main.go`,
  `internal/`), React/TypeScript frontend (`frontend/src/`)
- `internal/parse` — pure log-parsing logic, no file I/O or network,
  tested against real sample logs in `internal/parse/testdata/`
- `internal/officerapi` — HTTP client for seekers-tracker's
  `/api/officer/*` routes (`x-api-key` header)
- `internal/config` — persists the officer's API key and selected log path
  to a local JSON file
  (`~/Library/Application Support/seekers-epgp-parser/config.json` on
  macOS, `os.UserConfigDir()` generally); the server URL is a hardcoded
  constant (`officerapi.ServerURL`), not user-configurable — there's only
  ever one seekers-tracker instance
- `internal/updatecheck` — compares the running build against this repo's
  GitHub `releases/latest`, shows a startup banner if behind

**Config lives outside the binary**, in `os.UserConfigDir()`. This is
deliberate and already correct: it means a binary swap during a self-update
cannot lose the officer's settings (PLAN.md §7, Phase 8.3). Don't move config
next to the executable.

## Commands

```bash
go build ./...                    # compile check
go vet ./...
go test ./...                     # internal/parse's real-sample-log tests
wails generate module             # regenerate frontend/wailsjs/* bindings after any App method signature change
wails build                       # full app build -> build/bin/seekers-epgp-parser.app
open build/bin/seekers-epgp-parser.app   # launch it (macOS)
```

From `frontend/`: `npm run build` (tsc + vite) typechecks the frontend
alone, faster than a full `wails build` for iterating on UI-only changes.

## Workflow conventions

- **Commit after every task in PLAN.md §11**, scoped commits not one giant
  one — same convention as seekers-tracker. Reference the task in the
  message: `Phase 4.4: pre-check min attendance before submit`.
- **Always `wails generate module` before `wails build`** after touching
  any exported `App` method — and re-read the generated
  `frontend/wailsjs/go/main/App.d.ts` to confirm the signature came out
  the way you expect (see the Wails gotcha below; it fails silently, not
  with a build error).
- **Verify with real data before calling something fixed.** `go test
  ./internal/parse/...` alone has missed two real bugs (a JSON
  `null`-vs-`[]` crash, a bid-window logic bug) because it only exercises
  the parsing functions in isolation, not the actual `App` methods'
  JSON-serialized output the frontend receives. Write a throwaway
  `app_manual_test.go` (package `main`, repo root) that instantiates
  `&App{logPath: "internal/parse/testdata/..."}`, calls the real method,
  `json.Marshal`s the result, and asserts on the JSON string — then
  delete the file before committing.
- If a captured attendance/bid result looks visually broken in the app
  and you can't tell why, reproduce it with the throwaway-test approach
  above before guessing at a frontend fix — the last two real bugs were
  both in what the Go side produced, not the React rendering.
- **Point the app at a locally-running seekers-tracker while developing**
  (`wrangler dev --local`), not production. Local D1 has no row-read or
  write limits, and a bad test submit against production writes real ledger
  rows. See seekers-tracker's `CLAUDE.md` → "Local-first testing".

## Gotchas specific to this repo

- **`time.Parse` defaults to UTC.** EQ log timestamps have no zone of
  their own — they're the officer's local wall-clock time (same machine
  the client runs on). `internal/parse/logline.go` uses
  `time.ParseInLocation(logTimeLayout, s, time.Local)` — don't revert this
  to `time.Parse`, or displayed times shift by the machine's UTC offset.
- **Nil slices → JSON `null`.** Any struct field that crosses into
  `main.AttendanceResult`/`main.BidRow`/etc. and is typed as a plain array
  on the TS side must never be a Go nil slice — initialize with `[]T{}`,
  not `var x []T`. The frontend's `.map()` calls have no defensive nil
  guards (by design — the JSON contract is supposed to guarantee arrays).
- **Wails bindings drop extra return values silently.** `func (a *App)
  Foo() (x, y Thing, err error)` — Wails only binds `x` and treats `err`
  as the promise rejection; `y` vanishes from the generated
  `App.d.ts` with no error. Wrap multi-value returns in one struct
  (`PointValues`, `LedgerPage` in `app.go` are the pattern to copy).
- **Bid announcement window** (`internal/parse.FindAnnouncementStart`):
  groups consecutive "send tells" announcements for the same item within
  `announcementSessionGap` (10 min) into one round, anchoring the window
  to the *earliest* one — a "- last call" reminder must NOT reset the
  window, or every bid placed before the reminder gets silently excluded
  (this was a real bug, caught by the throwaway-test method above, not by
  the unit tests).
- **Tier rank for Determine Winner** (`frontend/src/BidsPanel.tsx`):
  High(4) > Medium(3) > Low(2) > Alt Loot(1) — Alt Loot ranks below Low
  Bid despite both costing 10 GP today. This lives client-side in TS, not
  Go — there's no unit test for it; verify by hand-tracing a scenario if
  you touch it.
- Character "Main" and "Priority" columns (Attendance/Bids/Manual
  Entry/Browse) are resolved **client-side** against a roster fetched
  once via `useRoster()` (`frontend/src/useRoster.ts`), not per-row Go
  round trips — editing a name in an editable table updates its
  Main/Priority live for exactly this reason.
- **`NoMatchSelect`** (`frontend/src/NoMatchSelect.tsx`, used by
  Attendance and Bids) resolves an unmatched captured name by calling
  `LinkCharacter` → `POST /api/officer/characters` on seekers-tracker,
  which creates the character with placeholder
  `class=UNKNOWN_CLASS_ID, race=UNKNOWN_RACE_ID, level=1` (same
  convention as that repo's `scripts/import-epgp.ts`) — the log only
  gives a name, never class/race/level. `useRoster().createCharacter`
  merges the created character into local state so the triggering row
  resolves without a full `FetchRoster` round trip. If that site route's
  contract changes, this is the other end of it.
- **Attendance dedupe is a server concern, but affects capture UX.**
  Project Quarm prohibits multiboxing, so one `/who` capture can't contain
  two characters from the same player. But a player may swap characters
  between captures within one event (main at Raid-Start, alt at Raid-End) —
  the server dedupes by player and logs the swap (PLAN.md §4h-1). Don't
  silently drop such rows client-side; let the officer see them.

## Status

See seekers-tracker's `CLAUDE.md` → Roadmap/status section for the
authoritative shipped/deferred list (kept in one place to avoid drift
between the repos), and `../PLAN.md` §11 for what's next.
