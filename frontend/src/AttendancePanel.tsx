import { useEffect, useMemo, useState } from "react";
import { Clipboard } from "@wailsio/runtime";
import {
  FetchGuildSettings,
  ListAttendanceSnapshots,
  SetAttendanceUnsaved,
  SubmitAttendance,
} from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";
import { NoMatchSelect } from "./NoMatchSelect";
import { useRoster } from "./useRoster";

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
  const roster = useRoster();

  useEffect(() => saveCaptures(captures), [captures]);

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

  async function onCapture() {
    setCapturing(true);
    setError(null);
    setSubmitSummary(null);
    try {
      const snaps = (await ListAttendanceSnapshots()) ?? [];
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
        if (added === 0) setError("No new /who snapshots in the log since the ones already listed.");
        // Newest first.
        return [...byId.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
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

  async function onSubmitAssigned() {
    const toSubmit = captures.filter((c) => c.assignment !== "" && !c.submitted);
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
        return;
      }
    }

    const done: string[] = [];
    try {
      for (const c of toSubmit) {
        const names = c.rows.map((r) => r.name.trim()).filter(Boolean);
        const res = await SubmitAttendance(c.assignment, c.occurredAt, names, c.zone);
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
      setSubmitSummary(`Submitted ${done.length} capture(s) — ${done.join(" · ")}. Review the notes, then Clear all when the raid's wrapped.`);
    } catch (err) {
      setError(`Stopped after ${done.length} of ${toSubmit.length}: ${String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="panel-header">
        <h2>Attendance</h2>
        <button className="primary" onClick={onCapture} disabled={capturing}>
          {capturing ? "Reading log…" : "Capture from log"}
        </button>
        <button
          className="primary"
          onClick={onSubmitAssigned}
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
          (or once at the end; every snapshot from the last 12h shows up). Assign the ones you want to Start / Mid / End, then
          Submit assigned. Nothing is sent until you do.
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
                    {short && <span style={{ color: "#f87171" }}> · {names.length} of {minAttendance} required</span>}
                  </span>
                  {c.submitted ? (
                    <span className="success" style={{ marginLeft: "auto", padding: "2px 8px" }}>
                      ✓ Recorded as {c.submitted.activity} ({c.submitted.inserted}){c.submitted.note ? ` —${c.submitted.note}` : ""}
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
    </div>
  );
}
