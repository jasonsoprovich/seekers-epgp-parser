import { useState } from "react";
import { CaptureAttendance, SubmitAttendance } from "../wailsjs/go/main/App";
import { ClipboardSetText } from "../wailsjs/runtime/runtime";
import { main } from "../wailsjs/go/models";
import { NoMatchSelect } from "./NoMatchSelect";
import { useRoster } from "./useRoster";

// `name` is the resolution/submission identity — looked up against the
// roster and sent to the site. `displayName` is frozen at capture time
// (or, for a manually added row, whatever the officer resolves it to) and
// is always shown in the Character column, so linking an unmatched name to
// a main doesn't overwrite the captured name — see BidsPanel's identical
// split for the same reason.
type EditableRow = { name: string; displayName: string };

// Matches the non-retired "ep" activities seeded in seekers-tracker's
// epgp_point_values (scripts/import-epgp.ts's POINT_VALUES) that a single
// "/who guild" snapshot could represent — the site resolves the actual
// point value from this name server-side, so this list only needs to stay
// in sync in spirit, not exact points.
const ACTIVITIES = ["Raid - Start", "Raid - Mid", "Raid - End", "Guild Meeting", "Event Attend"];

export function AttendancePanel() {
  const [snapshot, setSnapshot] = useState<main.AttendanceResult | null>(null);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [activity, setActivity] = useState(ACTIVITIES[0]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [submitResult, setSubmitResult] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const roster = useRoster();

  async function onCapture() {
    setPending(true);
    setError(null);
    setSubmitResult(null);
    try {
      const result = await CaptureAttendance();
      setSnapshot(result);
      setRows(result.names.map((name) => ({ name, displayName: name })));
    } catch (err) {
      setError(String(err));
      setSnapshot(null);
      setRows([]);
    } finally {
      setPending(false);
    }
  }

  // A manually added row has no captured text to preserve, so resolving it
  // sets displayName too; a captured row keeps its original displayName.
  function resolveIdentity(index: number, name: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { name, displayName: r.displayName.trim() ? r.displayName : name } : r)));
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function addRow() {
    setRows((prev) => [...prev, { name: "", displayName: "" }]);
  }

  async function onCopy() {
    if (!snapshot) return;
    const lines = rows.map((r) => `${r.name}\t${snapshot.occurredAt}`);
    await ClipboardSetText(lines.join("\n"));
    setCopied(true);
  }

  async function onSubmit() {
    if (!snapshot) return;
    setSubmitting(true);
    setSubmitResult(null);
    setError(null);
    try {
      const names = rows.map((r) => r.name.trim()).filter(Boolean);
      const result = await SubmitAttendance(activity, snapshot.occurredAt, names);
      const unmatchedNote = result.unmatched.length > 0 ? ` — no match for: ${result.unmatched.join(", ")}` : "";
      setSubmitResult(`Recorded ${activity} for ${result.inserted} character(s).${unmatchedNote}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="panel-header">
        <h2>Attendance</h2>
        <button className="primary" onClick={onCapture} disabled={pending}>
          {pending ? "Reading log…" : "Capture Attendance"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {submitResult && <div className="success">{submitResult}</div>}
      {roster.error && <div className="warning">Couldn't load the roster for Main/Priority lookup: {roster.error}</div>}
      {snapshot?.warnings.map((w, i) => (
        <div className="warning" key={i}>
          {w}
        </div>
      ))}

      {snapshot && (
        <>
          <div className="toolbar">
            <span style={{ color: "#9ca3af", fontSize: 13 }}>
              {snapshot.zone} — {new Date(snapshot.occurredAt).toLocaleString()} — {rows.length} name(s)
            </span>
            <select value={activity} onChange={(e) => setActivity(e.target.value)}>
              {ACTIVITIES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <button className="primary" onClick={onSubmit} disabled={submitting || rows.length === 0}>
              {submitting ? "Submitting…" : "Submit to site"}
            </button>
            <button className="secondary" onClick={addRow}>
              + Add row
            </button>
            <button className="secondary" onClick={onCopy}>
              {copied ? "Copied" : "Copy to clipboard"}
            </button>
          </div>
          <table className="col-fixed">
            <colgroup>
              <col style={{ width: "34%" }} />
              <col style={{ width: "34%" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "12%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Character</th>
                <th>Main</th>
                <th>Timestamp</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
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
                            onResolved={(canonicalName) => resolveIdentity(i, canonicalName)}
                            onError={setError}
                          />
                        )
                      ) : (
                        <NoMatchSelect name="" roster={roster} onResolved={(canonicalName) => resolveIdentity(i, canonicalName)} onError={setError} />
                      )}
                    </td>
                    <td>{new Date(snapshot.occurredAt).toLocaleTimeString()}</td>
                    <td>
                      <button className="danger" onClick={() => removeRow(i)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No names left — every row was removed.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {!snapshot && !error && (
        <div className="empty">
          Run "/who" or "/who guild" in-game, then click Capture Attendance — either works, use whichever one doesn't miss anon'd guildmates.
        </div>
      )}
    </div>
  );
}
