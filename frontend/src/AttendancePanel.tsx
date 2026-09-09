import { useEffect, useMemo, useState } from "react";
import { Clipboard } from "@wailsio/runtime";
import {
  CheckAttendanceRecorded,
  FetchGuildSettings,
  ListAttendanceSnapshots,
  SetAttendanceUnsaved,
  SubmitAttendance,
} from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";
import { ConfirmDialog } from "./ConfirmDialog";
import { NoMatchSelect } from "./NoMatchSelect";
import { useRoster } from "./useRoster";

// How far back to scan the log for "/who" blocks. 12h covers "did
// attendance right after the raid"; the wider windows are for doing it the
// next day, or a weekend player-quest timestamp. Server-side clamps to 72h.
const LOOKBACK_OPTIONS = [6, 12, 24, 48] as const;
const DEFAULT_LOOKBACK = 12;
const LOOKBACK_KEY = "seekers.attendance.lookbackHours";
const RAIDNAME_KEY = "seekers.attendance.raidName";

// Fallback minimum used only for the "< N" badge / sort when the site's
// min_attendance setting hasn't loaded yet. The server is still the
// authority on whether a short capture is actually accepted.
const FALLBACK_MIN_ATTENDANCE = 12;

function loadLookback(): number {
  const n = Number(window.localStorage.getItem(LOOKBACK_KEY));
  return (LOOKBACK_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_LOOKBACK;
}

// `name` is the resolution/submission identity — looked up against the
// roster and sent to the site. `displayName` is frozen at capture time (or,
// for a manually added row, whatever the officer resolves it to) and is
// always shown in the Character column, so linking an unmatched name to a
// main doesn't overwrite the captured name — see BidsPanel's identical
// split for the same reason.
type EditableRow = { name: string; displayName: string };

// "" = ignore this capture. The three Raid - * are the ones an officer
// assigns start/mid/end to; the site's ATTENDANCE_GATED_ACTIVITIES
// (min-attendance) covers those plus Event Attend.
const ASSIGNMENTS = ["", "Raid - Start", "Raid - Mid", "Raid - End", "Guild Meeting", "Event Attend"] as const;
type Assignment = (typeof ASSIGNMENTS)[number];

// At most one capture may hold each of these at a time (post-live-test-1
// LT-22 "do not allow multiple starts or mids or ends").
const UNIQUE_ASSIGNMENTS = new Set<Assignment>(["Raid - Start", "Raid - Mid", "Raid - End"]);

// Mirrors seekers-tracker's ATTENDANCE_GATED_ACTIVITIES
// (src/lib/epgp/attendance.ts) — the minimum applies only to these.
// Server-side is authoritative; this just lets the officer catch a short
// capture before wasting a submit.
const GATED = new Set<Assignment>(["Raid - Start", "Raid - Mid", "Raid - End", "Event Attend"]);

type SubmittedInfo = { activity: string; inserted: number; note: string };

// One /who snapshot the officer has captured. `id` is the block's
// occurredAt — stable and unique, so re-capturing merges instead of
// duplicating and edits survive.
type Capture = {
  id: string;
  occurredAt: string;
  zone: string;
  warnings: string[];
  rows: EditableRow[];
  assignment: Assignment;
  expanded: boolean;
  submitted?: SubmittedInfo;
};

// Captures live in the webview's localStorage so they survive a tab switch
// (App.tsx keeps panels mounted anyway) AND an app restart mid-raid — the
// officer captures start/mid/end over hours and only submits at the end
// (LT-21/LT-23). "Clear all" or submitting + clearing is how they reset.
const STORAGE_KEY = "seekers.attendance.captures";

function loadCaptures(): Capture[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c): c is Capture => !!c && typeof (c as Capture).id === "string" && Array.isArray((c as Capture).rows))
      .map((c) => ({ ...c, expanded: false }));
  } catch {
    return [];
  }
}

function saveCaptures(captures: Capture[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(captures));
  } catch {
    // best-effort — a full/blocked store just means no cross-restart persistence
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function AttendancePanel() {
  const [captures, setCaptures] = useState<Capture[]>(loadCaptures);
  const [error, setError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitSummary, setSubmitSummary] = useState<string | null>(null);
  const [minAttendance, setMinAttendance] = useState<number | null>(null);
  const [lookbackHours, setLookbackHours] = useState<number>(loadLookback);
  const [raidName, setRaidName] = useState<string>(() => window.localStorage.getItem(RAIDNAME_KEY) ?? "");
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Pre-submit "already in the ledger?" results, keyed by capture id.
  // "checking" while the probe is in flight; absent = not checked / probe
  // failed (no warning shown, submit still allowed).
  const [dupChecks, setDupChecks] = useState<Record<string, { count: number } | "checking">>({});
  const roster = useRoster();

  useEffect(() => saveCaptures(captures), [captures]);
  useEffect(() => {
    try {
      window.localStorage.setItem(LOOKBACK_KEY, String(lookbackHours));
    } catch {
      // best-effort
    }
  }, [lookbackHours]);
  useEffect(() => {
    try {
      window.localStorage.setItem(RAIDNAME_KEY, raidName);
    } catch {
      // best-effort
    }
  }, [raidName]);

  // Feed the close-confirmation guard (LT-24): any capture that hasn't been
  // submitted is unsent work.
  useEffect(() => {
    SetAttendanceUnsaved(captures.some((c) => !c.submitted)).catch(() => {});
  }, [captures]);
  useEffect(() => () => void SetAttendanceUnsaved(false).catch(() => {}), []);

  // Best-effort, same as everywhere else settings get read (PLAN.md §4i).
  useEffect(() => {
    FetchGuildSettings()
      .then((s) => setMinAttendance(s.MinAttendance))
      .catch(() => setMinAttendance(null));
  }, []);

  const takenUnique = useMemo(() => {
    const m = new Map<Assignment, string>();
    for (const c of captures) if (UNIQUE_ASSIGNMENTS.has(c.assignment)) m.set(c.assignment, c.id);
    return m;
  }, [captures]);

  const assignedCount = captures.filter((c) => c.assignment !== "" && !c.submitted).length;

  // Threshold for the "< N" badge and the raid-sized-first sort. Server is
  // still the authority on acceptance — this is just to keep small `/who
  // Name` lookups from burying the real start/mid/end captures.
  const effectiveMin = minAttendance ?? FALLBACK_MIN_ATTENDANCE;
  const nameCount = (c: Capture) => c.rows.map((r) => r.name.trim()).filter(Boolean).length;
  const isRaidSized = (c: Capture) => nameCount(c) >= effectiveMin;

  // Raid-sized captures first, then newest-first within each group. Sub-12
  // captures stay visible (the officer may still need to add names to one
  // by hand) — just sorted below the full ones and badged.
  function sortCaptures(list: Capture[]): Capture[] {
    return [...list].sort((a, b) => {
      const ra = isRaidSized(a) ? 0 : 1;
      const rb = isRaidSized(b) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return b.occurredAt.localeCompare(a.occurredAt);
    });
  }

  async function onCapture() {
    setCapturing(true);
    setError(null);
    setSubmitSummary(null);
    try {
      const snaps = (await ListAttendanceSnapshots(lookbackHours)) ?? [];
      setCaptures((prev) => {
        const byId = new Map(prev.map((c) => [c.id, c]));
        let added = 0;
        for (const s of snaps) {
          if (byId.has(s.occurredAt)) continue;
          added++;
          byId.set(s.occurredAt, {
            id: s.occurredAt,
            occurredAt: s.occurredAt,
            zone: s.zone ?? "",
            warnings: s.warnings ?? [],
            rows: (s.names ?? []).map((name) => ({ name, displayName: name })),
            assignment: "",
            expanded: false,
          });
        }
        if (added === 0) setError(`No new /who snapshots in the log for the last ${lookbackHours}h.`);
        return sortCaptures([...byId.values()]);
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setCapturing(false);
    }
  }

  function patch(id: string, fn: (c: Capture) => Capture) {
    setCaptures((prev) => prev.map((c) => (c.id === id ? fn(c) : c)));
  }

  function setAssignment(id: string, assignment: Assignment) {
    setCaptures((prev) =>
      prev.map((c) => {
        if (c.id === id) return { ...c, assignment };
        // Steal a unique assignment from whoever else held it.
        if (assignment !== "" && UNIQUE_ASSIGNMENTS.has(assignment) && c.assignment === assignment) {
          return { ...c, assignment: "" };
        }
        return c;
      }),
    );
  }

  function editRow(id: string, index: number, name: string) {
    patch(id, (c) => ({
      ...c,
      rows: c.rows.map((r, i) => (i === index ? { name, displayName: r.displayName.trim() ? r.displayName : name } : r)),
    }));
  }
  function removeRow(id: string, index: number) {
    patch(id, (c) => ({ ...c, rows: c.rows.filter((_, i) => i !== index) }));
  }
  function addRow(id: string) {
    patch(id, (c) => ({ ...c, rows: [...c.rows, { name: "", displayName: "" }] }));
  }
  function removeCapture(id: string) {
    setCaptures((prev) => prev.filter((c) => c.id !== id));
  }
  function clearAll() {
    setCaptures([]);
    setError(null);
    setSubmitSummary(null);
  }

  async function onCopy(c: Capture) {
    const lines = c.rows.map((r) => `${r.name}\t${c.occurredAt}`);
    await Clipboard.SetText(lines.join("\n"));
  }

  const toSubmit = captures.filter((c) => c.assignment !== "" && !c.submitted);
  // Captures that would actually write something — not-yet-checked and
  // still-checking count as "new" so the button label isn't alarmist mid-probe.
  const dupNewCount = toSubmit.filter((c) => {
    const ch = dupChecks[c.id];
    return !ch || ch === "checking" || ch.count === 0;
  }).length;

  async function onSubmitClick() {
    if (toSubmit.length === 0) return;
    setError(null);
    setSubmitSummary(null);
    // Probe each assigned capture against the ledger so the dialog can flag
    // "already recorded — this would be a no-op" before the officer
    // commits. Best-effort: a failed probe just shows no warning.
    setDupChecks(Object.fromEntries(toSubmit.map((c) => [c.id, "checking" as const])));
    setConfirmOpen(true);
    await Promise.all(
      toSubmit.map(async (c) => {
        try {
          const res = await CheckAttendanceRecorded(c.assignment, c.occurredAt);
          setDupChecks((prev) => ({ ...prev, [c.id]: { count: res.count } }));
        } catch {
          setDupChecks((prev) => {
            const next = { ...prev };
            delete next[c.id];
            return next;
          });
        }
      }),
    );
  }

  async function doSubmit() {
    if (toSubmit.length === 0) return;

    setSubmitting(true);
    setError(null);
    setSubmitSummary(null);

    // Re-validate the minimum at submit (PLAN.md §4i) — a leader may have
    // changed it since the tab mounted. Server enforces it regardless.
    let required = minAttendance;
    try {
      required = (await FetchGuildSettings()).MinAttendance;
      setMinAttendance(required);
    } catch {
      // fall back to whatever was loaded
    }

    for (const c of toSubmit) {
      const names = c.rows.map((r) => r.name.trim()).filter(Boolean);
      if (GATED.has(c.assignment) && required !== null && names.length < required) {
        setError(`${c.assignment} (${fmtTime(c.occurredAt)}): only ${names.length} of ${required} required members — assign fixed or remove it, then submit again.`);
        setSubmitting(false);
        setConfirmOpen(false);
        return;
      }
    }

    const trimmedRaidName = raidName.trim();
    const done: string[] = [];
    try {
      for (const c of toSubmit) {
        const names = c.rows.map((r) => r.name.trim()).filter(Boolean);
        const res = await SubmitAttendance(c.assignment, c.occurredAt, names, c.zone, trimmedRaidName);
        const unmatched = res.unmatched ?? [];
        const duplicates = res.duplicates ?? [];
        const note =
          (unmatched.length ? ` no match: ${unmatched.join(", ")};` : "") +
          (duplicates.length ? ` already recorded: ${duplicates.join(", ")};` : "");
        setCaptures((prev) =>
          prev.map((x) => (x.id === c.id ? { ...x, submitted: { activity: c.assignment, inserted: res.inserted, note } } : x)),
        );
        done.push(`${c.assignment}: ${res.inserted}`);
      }
      setSubmitSummary(
        `Submitted ${done.length} capture(s) — ${done.join(" · ")}${trimmedRaidName ? ` · raid "${trimmedRaidName}"` : ""}. Review the notes, then Clear all when the raid's wrapped.`,
      );
    } catch (err) {
      setError(`Stopped after ${done.length} of ${toSubmit.length}: ${String(err)}`);
    } finally {
      setSubmitting(false);
      setConfirmOpen(false);
      setDupChecks({});
    }
  }

  return (
    <div>
      <div className="panel-header" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2>Attendance</h2>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#9ca3af" }}>
          Look back
          <select value={lookbackHours} onChange={(e) => setLookbackHours(Number(e.target.value))} disabled={capturing}>
            {LOOKBACK_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {h}h
              </option>
            ))}
          </select>
        </label>
        <button className="primary" onClick={onCapture} disabled={capturing}>
          {capturing ? "Reading log…" : "Capture from log"}
        </button>
        <input
          type="text"
          placeholder="Raid name (optional)"
          value={raidName}
          onChange={(e) => setRaidName(e.target.value)}
          style={{ minWidth: 180 }}
          title={'Names the night on the site Raids & Events page — e.g. "VT 9/8". Leave blank to name it there later.'}
        />
        <button
          className="primary"
          onClick={onSubmitClick}
          disabled={submitting || assignedCount === 0}
        >
          {submitting ? "Submitting…" : `Submit assigned (${assignedCount})`}
        </button>
        <button className="secondary" onClick={clearAll} disabled={submitting || captures.length === 0}>
          Clear all
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {submitSummary && <div className="success">{submitSummary}</div>}
      {roster.error && (
        <div className="warning">
          Couldn't load the roster for Main/Priority lookup: {roster.error}{" "}
          <button className="secondary" style={{ marginLeft: 8 }} onClick={roster.reload} disabled={roster.loading}>
            {roster.loading ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}

      {captures.length === 0 ? (
        <div className="empty">
          Run "/who" or "/who guild" in-game at the start, middle, and end of the raid — click "Capture from log" after each
          (or once at the end; every snapshot from the last {lookbackHours}h shows up — widen "Look back" if you're doing this
          the next day). Assign the ones you want to Start / Mid / End, then Submit assigned. Nothing is sent until you do.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span style={{ color: "#9ca3af", fontSize: 13 }}>
            {captures.length} capture(s) · {assignedCount} assigned & unsent
          </span>
          {captures.map((c) => {
            const names = c.rows.map((r) => r.name.trim()).filter(Boolean);
            const short = GATED.has(c.assignment) && minAttendance !== null && names.length < minAttendance;
            return (
              <div key={c.id} className="capture-card" style={{ border: "1px solid #2a3550", borderRadius: 6 }}>
                <div
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", flexWrap: "wrap" }}
                >
                  <button className="secondary" onClick={() => patch(c.id, (x) => ({ ...x, expanded: !x.expanded }))}>
                    {c.expanded ? "▾" : "▸"}
                  </button>
                  <span style={{ fontSize: 13 }}>
                    {fmtTime(c.occurredAt)}
                    {c.zone ? ` · ${c.zone}` : ""} · <strong>{c.rows.length}</strong> name(s)
                    {!c.submitted && names.length < effectiveMin && (
                      <span
                        className="badge"
                        style={{ marginLeft: 6, color: "#fbbf24", border: "1px solid #fbbf2455", borderRadius: 4, padding: "1px 5px", fontSize: 11 }}
                        title={`Fewer than ${effectiveMin} names — likely a "/who <name>" lookup or a partial capture. Add names by hand if it's really a raid tick.`}
                      >
                        &lt; {effectiveMin}
                      </span>
                    )}
                    {short && <span style={{ color: "#f87171" }}> · {names.length} of {minAttendance} required</span>}
                  </span>
                  {c.submitted ? (
                    <span
                      className={c.submitted.inserted === 0 ? "warning" : "success"}
                      style={{ marginLeft: "auto", padding: "2px 8px" }}
                    >
                      {c.submitted.inserted === 0 ? "⚠ Nothing new" : "✓ Recorded"} — {c.submitted.activity} (
                      {c.submitted.inserted} new){c.submitted.note ? ` —${c.submitted.note}` : ""}
                    </span>
                  ) : (
                    <select
                      style={{ marginLeft: "auto" }}
                      value={c.assignment}
                      onChange={(e) => setAssignment(c.id, e.target.value as Assignment)}
                    >
                      {ASSIGNMENTS.map((a) => {
                        const takenBy = UNIQUE_ASSIGNMENTS.has(a) ? takenUnique.get(a) : undefined;
                        return (
                          <option key={a || "none"} value={a} disabled={!!takenBy && takenBy !== c.id}>
                            {a === "" ? "— ignore" : a}
                            {takenBy && takenBy !== c.id ? " (taken)" : ""}
                          </option>
                        );
                      })}
                    </select>
                  )}
                  {!c.submitted && (
                    <button className="danger" onClick={() => removeCapture(c.id)}>
                      Remove
                    </button>
                  )}
                </div>

                {c.warnings.map((w, i) => (
                  <div className="warning" key={i} style={{ margin: "0 10px 8px" }}>
                    {w}
                  </div>
                ))}

                {c.expanded && (
                  <div style={{ padding: "0 10px 10px" }}>
                    <div className="toolbar">
                      <button className="secondary" onClick={() => addRow(c.id)} disabled={!!c.submitted}>
                        + Add row
                      </button>
                      <button className="secondary" onClick={() => onCopy(c)}>
                        Copy to clipboard
                      </button>
                    </div>
                    <table className="col-fixed">
                      <colgroup>
                        <col style={{ width: "40%" }} />
                        <col style={{ width: "40%" }} />
                        <col style={{ width: "20%" }} />
                      </colgroup>
                      <thead>
                        <tr>
                          <th>Character</th>
                          <th>Main</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.rows.map((r, i) => {
                          const resolved = roster.resolve(r.name);
                          return (
                            <tr key={i}>
                              <td>{r.displayName.trim() ? r.displayName : "—"}</td>
                              <td style={{ color: resolved.matched ? "#9ca3af" : "#f87171" }}>
                                {r.name.trim() ? (
                                  resolved.matched ? (
                                    resolved.mainCharacterName
                                  ) : (
                                    <NoMatchSelect
                                      name={r.displayName}
                                      roster={roster}
                                      onResolved={(canonicalName) => editRow(c.id, i, canonicalName)}
                                      onError={setError}
                                    />
                                  )
                                ) : (
                                  <NoMatchSelect
                                    name=""
                                    roster={roster}
                                    onResolved={(canonicalName) => editRow(c.id, i, canonicalName)}
                                    onError={setError}
                                  />
                                )}
                              </td>
                              <td>
                                <button className="danger" onClick={() => removeRow(c.id, i)} disabled={!!c.submitted}>
                                  Remove
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                        {c.rows.length === 0 && (
                          <tr>
                            <td colSpan={3} className="empty">
                              No names left — every row was removed.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Submit attendance to the site?"
        confirmLabel={
          dupNewCount === 0 && Object.keys(dupChecks).length > 0
            ? "Submit anyway"
            : `Submit ${dupNewCount || toSubmit.length} capture(s)`
        }
        busy={submitting}
        onCancel={() => {
          setConfirmOpen(false);
          setDupChecks({});
        }}
        onConfirm={() => void doSubmit()}
        body={
          <>
            <p style={{ margin: "0 0 8px" }}>This writes EP to the ledger for everyone in these captures:</p>
            <ul style={{ margin: "0 0 8px", paddingLeft: 18 }}>
              {toSubmit.map((c) => {
                const n = c.rows.map((r) => r.name.trim()).filter(Boolean).length;
                const check = dupChecks[c.id];
                return (
                  <li key={c.id}>
                    <strong>{c.assignment}</strong> — {fmtTime(c.occurredAt)}
                    {c.zone ? ` · ${c.zone}` : ""} · {n} name(s)
                    {n < effectiveMin ? <span style={{ color: "#fbbf24" }}> · under {effectiveMin}</span> : null}
                    {check === "checking" && <span style={{ color: "#9ca3af" }}> · checking…</span>}
                    {check && check !== "checking" && check.count > 0 && (
                      <span style={{ color: "#fbbf24" }}> · ⚠ already recorded ({check.count} rows) — this would be a no-op</span>
                    )}
                    {check && check !== "checking" && check.count === 0 && <span style={{ color: "#10b981" }}> · new</span>}
                  </li>
                );
              })}
            </ul>
            {dupNewCount === 0 && Object.keys(dupChecks).length > 0 && (
              <p style={{ margin: "0 0 8px", color: "#fbbf24" }}>
                Every capture here is already in the database. Submitting again writes nothing (the site dedupes by
                player + activity + time). Only do this if you deliberately reversed the raid first.
              </p>
            )}
            {raidName.trim() ? (
              <p style={{ margin: 0 }}>
                Raid name: <strong>{raidName.trim()}</strong> (only applied if the night isn't named yet).
              </p>
            ) : (
              <p style={{ margin: 0, color: "#9ca3af" }}>No raid name — you can name it on the site later.</p>
            )}
          </>
        }
      />
    </div>
  );
}
