import { useState } from "react";
import { SubmitAttendance } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";

// Mirrors AttendancePanel's ACTIVITIES / seekers-tracker's epgp_point_values.
const ACTIVITIES = ["Raid - Start", "Raid - Mid", "Raid - End", "Guild Meeting", "Event Attend"];

function nowLocalInput(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

// For when a /who capture was missed (app not running, log not written) and
// a few names need adding after the fact. The site dedupes by
// (player, activity, time), so re-submitting a name that's already recorded
// is reported back as "already recorded, skipped" rather than doubled.
export function MissedAttendanceForm() {
  const [activity, setActivity] = useState(ACTIVITIES[0]);
  const [occurredAt, setOccurredAt] = useState(nowLocalInput);
  const [zone, setZone] = useState("");
  const [namesText, setNamesText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setSuccess(null);
    const names = namesText
      .split(/\r?\n/)
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.length === 0) return setError("Enter at least one name (one per line).");
    const iso = new Date(occurredAt).toISOString();
    if (Number.isNaN(Date.parse(iso))) return setError("Pick a valid date/time.");

    setPending(true);
    try {
      const resp = await SubmitAttendance(activity, iso, names, zone.trim());
      const unmatched = resp.unmatched ?? [];
      const duplicates = resp.duplicates ?? [];
      const notes: string[] = [];
      if (unmatched.length) notes.push(`no match for: ${unmatched.join(", ")}`);
      if (duplicates.length) notes.push(`already recorded, skipped: ${duplicates.join(", ")}`);
      setSuccess(`Recorded ${activity} for ${resp.inserted} character(s).${notes.length ? " — " + notes.join(" — ") : ""}`);
      if (resp.inserted > 0) setNamesText("");
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
          <input type="text" value={zone} onChange={(e) => setZone(e.target.value)} placeholder="e.g. Vex Thal" />
        </label>
      </div>

      <div className="form-row">
        <label style={{ flex: 1 }}>
          Names (one per line)
          <textarea rows={6} value={namesText} onChange={(e) => setNamesText(e.target.value)} placeholder={"Osui\nTakkisina\nKaalos"} />
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
