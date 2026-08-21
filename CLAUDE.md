# seekers-epgp-parser

Standalone desktop app (Wails: Go backend + React/TS frontend) an officer
runs on their own machine to parse EverQuest log files for raid attendance
and loot bids, then submit them to **seekers-tracker**
(`~/repos/github.com/jasonsoprovich/seekers-tracker`, sibling repo — the
guild's Next.js/Cloudflare website). Read that repo's `CLAUDE.md` too; it
has the full picture of how the two connect and the wider roadmap. This
file is the app-specific half.

## Stack

- [Wails v2](https://wails.io) — Go backend (`app.go`, `main.go`,
  `internal/`), React/TypeScript frontend (`frontend/src/`)
- `internal/parse` — pure log-parsing logic, no file I/O or network,
  tested against real sample logs in `internal/parse/testdata/`
- `internal/officerapi` — HTTP client for seekers-tracker's
  `/api/officer/*` routes (`x-api-key` header)
- `internal/config` — persists just the officer's API key to a local JSON
  file (`~/Library/Application Support/seekers-epgp-parser/config.json`
  on macOS); the server URL is a hardcoded constant
  (`officerapi.ServerURL`), not user-configurable — there's only ever one
  seekers-tracker instance

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

- **Commit after every major feature**, scoped commits not one giant one
  — same convention as seekers-tracker.
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

## Releases & update checks

There's no installer and no silent auto-updater — Wails doesn't ship one
(unlike Electron), and building a self-replacing updater wasn't worth the
complexity for a handful of officers. Instead: officers get **prompted**
in-app when they're behind, and manually re-download.

- **`main.Version`** (`main.go`) is `"dev"` by default; `.github/workflows/build-windows.yml`
  sets it via `-ldflags "-X main.Version=vX.Y.Z"` only when the trigger is
  a `vX.Y.Z` tag push. Push-to-main / manual-dispatch builds stay `"dev"`
  and are Actions-artifact-only, not published as a Release.
- **To cut a real release officers should install:** bump to a
  `vX.Y.Z` tag and push it (`git tag vX.Y.Z && git push origin vX.Y.Z`).
  The workflow builds, then publishes a GitHub Release with the `.exe`
  attached via `softprops/action-gh-release`. That's the same
  `releases/latest` GitHub API endpoint `internal/updatecheck` polls.
- **`internal/updatecheck.Check`** (called by `App.CheckForUpdate`, wired
  into `frontend/src/App.tsx`'s startup banner) compares `main.Version`
  against `GET /repos/.../releases/latest`. A `"dev"` build always
  short-circuits to "no update available" — there's nothing meaningful to
  compare a local build against. Comparison is plain string inequality on
  the tag (not real semver ordering) — safe only because releases are
  always published in order and "latest" is GitHub's own notion of most
  recent, not something this app computes itself.
- Errors from the update check (offline, GitHub unreachable, no releases
  published yet) are swallowed by the frontend — it just skips the
  banner rather than surfacing a fetch error to the officer.

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
  `App.d.ts`with no error. Wrap multi-value returns in one struct
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

## Status

See seekers-tracker's `CLAUDE.md` → Roadmap/status section for the
authoritative shipped/deferred list (kept in one place to avoid drift
between the two repos).
