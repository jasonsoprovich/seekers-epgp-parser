import { useState } from "react";
import { CaptureAttendance } from "../wailsjs/go/main/App";
import { ClipboardSetText } from "../wailsjs/runtime/runtime";
import { main } from "../wailsjs/go/models";

type EditableRow = { name: string };

export function AttendancePanel() {
  const [snapshot, setSnapshot] = useState<main.AttendanceResult | null>(null);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  async function onCapture() {
    setPending(true);
    setError(null);
    setCopied(false);
    try {
      const result = await CaptureAttendance();
      setSnapshot(result);
      setRows(result.names.map((name) => ({ name })));
    } catch (err) {
      setError(String(err));
      setSnapshot(null);
      setRows([]);
    } finally {
      setPending(false);
    }
  }

  function updateName(index: number, value: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { name: value } : r)));
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  async function onCopy() {
    if (!snapshot) return;
    const lines = rows.map((r) => `${r.name}\t${snapshot.occurredAt}`);
    await ClipboardSetText(lines.join("\n"));
    setCopied(true);
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
            <button className="secondary" onClick={onCopy}>
              {copied ? "Copied" : "Copy to clipboard"}
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Timestamp</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <input type="text" value={r.name} onChange={(e) => updateName(i, e.target.value)} />
                  </td>
                  <td>{new Date(snapshot.occurredAt).toLocaleTimeString()}</td>
                  <td>
                    <button className="danger" onClick={() => removeRow(i)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="empty">
                    No names left — every row was removed.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {!snapshot && !error && (
        <div className="empty">Run "/who guild" in-game, then click Capture Attendance.</div>
      )}
    </div>
  );
}
