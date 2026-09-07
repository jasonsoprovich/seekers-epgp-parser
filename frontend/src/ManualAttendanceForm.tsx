import { useEffect, useMemo, useState } from "react";
import { FetchGuildSettings, ParseAttendanceText, SubmitAttendance } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";

// "Event Attend" first: the main reason this form exists is player-run
// quests, whose attendance reaches an officer as a pasted log rather than a
// /who the app captured. The old raid activities stay available for
// after-the-fact fixes to a missed live capture.
const ACTIVITIES = ["Event Attend", "Raid - Start", "Raid - Mid", "Raid - End", "Guild Meeting"];

// Mirrors seekers-tracker's ATTENDANCE_GATED_ACTIVITIES
// (src/lib/epgp/attendance.ts) — the minimum-headcount rule applies to
// these; Guild Meeting is exempt. Server-side is authoritative regardless;
// this just lets the officer catch a short list before a wasted submit.
const GATED_ACTIVITIES = new Set(["Raid - Start", "Raid - Mid", "Raid - End", "Event Attend"]);

function nowLocalInput(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function toLocalInput(rfc3339: string): string | null {
  const d = new Date(rfc3339);
  if (Number.isNaN(d.getTime())) return null;
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

// Attendance entered by hand — for a /who the app missed (not running, log
// not written) or a player-run quest an officer has to record from a
// pasted log. Names go in one per line; the "paste a log" box runs the
// same /who parser the Attendance tab uses (App.ParseAttendanceText) and
// merges the names it finds into the list, still editable before submit.
// The site dedupes by (player, activity, time), so re-submitting a name
// already on file comes back as "already recorded, skipped" rather than
// doubled.
export function ManualAttendanceForm() {
  const [activity, setActivity] = useState(ACTIVITIES[0]);
  const [occurredAt, setOccurredAt] = useState(nowLocalInput);
  const [zone, setZone] = useState("");
  const [namesText, setNamesText] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [parseNote, setParseNote] = useState<string | null>(null);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [parsing, setParsing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [minAttendance, setMinAttendance] = useState<number | null>(null);

  // Best-effort, same as everywhere else settings are read (PLAN.md §4i) —
  // a missing value just skips the pre-check; the server still enforces the
  // real minimum.
  useEffect(() => {
    FetchGuildSettings()
      .then((s) => setMinAttendance(s.MinAttendance))
      .catch(() => setMinAttendance(null));
  }, []);

  const names = useMemo(
    () =>
      namesText
        .split(/\r?\n/)
        .map((n) => n.trim())
        .filter(Boolean),
    [namesText],
  );
  const uniqueCount = useMemo(() => new Set(names.map((n) => n.toLowerCase())).size, [names]);
  const gated = GATED_ACTIVITIES.has(activity);
  const short = gated && minAttendance !== null && uniqueCount < minAttendance;

  async function extractNames() {
    setError(null);
    setParseNote(null);
    setParseWarnings([]);
    if (!pasteText.trim()) {
      setError("Paste some log text first.");
      return;
    }
    setParsing(true);
    try {
      const res = await ParseAttendanceText(pasteText);
      const parsed = res.names ?? [];
      const seen = new Set(names.map((n) => n.toLowerCase()));
      const added: string[] = [];
      for (const n of parsed) {
        const key = n.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        added.push(n);
      }
      setNamesText([...names, ...added].join("\n"));
      if (res.zone && !zone.trim()) setZone(res.zone);
      if (res.occurredAt) {
        const local = toLocalInput(res.occurredAt);
        if (local) setOccurredAt(local);
      }
      setParseWarnings(res.warnings ?? []);
      setParseNote(
        added.length > 0
          ? `Added ${added.length} name${added.length === 1 ? "" : "s"} from the log${
              parsed.length !== added.length ? ` (${parsed.length - added.length} already listed)` : ""
            }.`
          : `No new names — all ${parsed.length} were already in the list.`,
      );
      setPasteText("");
    } catch (err) {
      setError(String(err));
    } finally {
      setParsing(false);
    }
  }

  async function submit() {
    setError(null);
    setSuccess(null);
    if (names.length === 0) {
      setError("Enter at least one name (one per line), or paste a log and extract them.");
      return;
    }
    const iso = new Date(occurredAt).toISOString();
    if (Number.isNaN(Date.parse(iso))) {
      setError("Pick a valid date/time.");
      return;
    }
    if (short) {
      setError(
        `Only ${uniqueCount} of ${minAttendance} required for "${activity}" — a player quest still needs ${minAttendance}+ attendees to earn EP.`,
      );
      return;
    }

    setPending(true);
    try {
      const resp = await SubmitAttendance(activity, iso, names, zone.trim());
      const unmatched = resp.unmatched ?? [];
      const duplicates = resp.duplicates ?? [];
      const notes: string[] = [];
      if (unmatched.length) notes.push(`no match for: ${unmatched.join(", ")}`);
      if (duplicates.length) notes.push(`already recorded, skipped: ${duplicates.join(", ")}`);
      setSuccess(`Recorded ${activity} for ${resp.inserted} character(s).${notes.length ? " — " + notes.join(" — ") : ""}`);
      if (resp.inserted > 0) {
        setNamesText("");
        setParseNote(null);
        setParseWarnings([]);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="form-card">
      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      <div className="form-row">
        <label>
          Activity
          <select value={activity} onChange={(e) => setActivity(e.target.value)}>
            {ACTIVITIES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label>
          When
          <input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </label>
        <label>
          Zone (optional)
          <input type="text" value={zone} onChange={(e) => setZone(e.target.value)} placeholder="e.g. Plane of Sky" />
        </label>
      </div>

      <div className="form-row">
        <button type="button" className="secondary" onClick={() => setShowPaste((v) => !v)}>
          {showPaste ? "▾" : "▸"} Paste a log to extract names
        </button>
      </div>

      {showPaste && (
        <div className="form-row">
          <label style={{ flex: 1 }}>
            Log text (a <code>/who</code> the officer ran in-game — e.g. for a player quest)
            <textarea
              rows={6}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={"[Sun Mar 02 20:14:03 2025] Players on EverQuest:\n[Sun Mar 02 20:14:03 2025] ---------------------------\n[Sun Mar 02 20:14:03 2025] [60 Warrior] Osui <Seekers of Souls>\n..."}
            />
          </label>
        </div>
      )}

      {showPaste && (
        <div className="form-row">
          <button type="button" className="secondary" onClick={extractNames} disabled={parsing || !pasteText.trim()}>
            {parsing ? "Extracting…" : "Extract names"}
          </button>
        </div>
      )}

      {parseNote && <div className="success">{parseNote}</div>}
      {parseWarnings.map((w, i) => (
        <div key={i} className="warning">
          {w}
        </div>
      ))}

      <div className="form-row">
        <label style={{ flex: 1 }}>
          Names (one per line) — {uniqueCount} unique
          {gated && minAttendance !== null && (
            <span style={{ color: short ? "#f87171" : "#9ca3af" }}> · need {minAttendance}+ to earn EP</span>
          )}
          <textarea rows={8} value={namesText} onChange={(e) => setNamesText(e.target.value)} placeholder={"Osui\nTakkisina\nKaalos"} />
        </label>
      </div>

      <div className="form-actions">
        <button className="primary" onClick={submit} disabled={pending}>
          {pending ? "Recording…" : "Record attendance"}
        </button>
      </div>
    </div>
  );
}
