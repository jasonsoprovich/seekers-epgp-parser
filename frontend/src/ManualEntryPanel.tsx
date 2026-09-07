import { useEffect, useState } from "react";
import { FetchPointValues, SubmitManualEntry } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";
import type { PointValue } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/internal/officerapi/models";
import { ManualAttendanceForm } from "./ManualAttendanceForm";
import { useOfficerDataGeneration } from "./officerData";
import { useRoster } from "./useRoster";

const CUSTOM = "__custom__";

type Mode = "adjust" | "attendance";

// Two things live here:
//   - "adjust": journal-entry EP/GP (bank donations, milestones, ad-hoc
//     corrections) — posts to /api/officer/manual-entry at the current time.
//   - "attendance": names to add to an event the /who capture missed, or a
//     player-run quest recorded from a pasted log (ManualAttendanceForm).
// A missed *bid* is not entered here anymore — it's added to the live round
// on the Bids tab, before the winner is finalized, because a bid recorded
// after the item's been awarded can't be acted on.
export function ManualEntryPanel() {
  const [mode, setMode] = useState<Mode>("adjust");
  const [kind, setKind] = useState<"ep" | "gp">("ep");
  const [pointValues, setPointValues] = useState<PointValue[]>([]);
  const [characterId, setCharacterId] = useState<number | "">("");
  const [activitySelect, setActivitySelect] = useState("");
  const [customActivity, setCustomActivity] = useState("");
  const [itemName, setItemName] = useState("");
  const [zone, setZone] = useState("");
  const [points, setPoints] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pointValuesError, setPointValuesError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const roster = useRoster();
  // Re-run the point-values fetch when the key is saved or Retry is clicked
  // — same reason useRoster subscribes: this effect's failure was otherwise
  // frozen for the whole session (see officerData.ts).
  const dataGen = useOfficerDataGeneration();

  useEffect(() => {
    let cancelled = false;
    FetchPointValues()
      .then((pv) => {
        if (cancelled) return;
        setPointValues((kind === "ep" ? pv.ep : pv.gp) ?? []);
        setPointValuesError(null);
      })
      .catch((err) => {
        if (!cancelled) setPointValuesError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [kind, dataGen]);

  function onSelectActivity(value: string) {
    setActivitySelect(value);
    if (value === CUSTOM) return;
    const found = pointValues.find((pv) => pv.activity === value);
    if (found) setPoints(String(found.points));
  }

  async function onSubmit() {
    setError(null);
    setSuccess(null);
    if (characterId === "") {
      setError("Pick a character.");
      return;
    }
    const activity = activitySelect === CUSTOM ? customActivity.trim() : activitySelect;
    if (!activity) {
      setError(kind === "ep" ? "Pick or type an activity." : "Pick or type a tier.");
      return;
    }
    const pointsNum = Number(points);
    if (!Number.isFinite(pointsNum)) {
      setError("Points must be a number.");
      return;
    }

    setPending(true);
    try {
      await SubmitManualEntry({
        kind,
        characterId,
        activity: kind === "ep" ? activity : undefined,
        tier: kind === "gp" ? activity : undefined,
        itemName: kind === "gp" ? itemName.trim() : undefined,
        zone: kind === "ep" ? zone.trim() : undefined,
        points: pointsNum,
        occurredAt: new Date().toISOString(),
        note: note.trim(),
      });
      const characterName = roster.characters.find((c) => c.id === characterId)?.name ?? "character";
      setSuccess(`Recorded ${pointsNum} ${kind.toUpperCase()} for ${characterName} (${activity}).`);
      setPoints("");
      setNote("");
      setItemName("");
      setZone("");
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div className="panel-header">
        <h2>Manual Entry</h2>
        <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="adjust">EP / GP adjustment</option>
          <option value="attendance">Manual attendance</option>
        </select>
      </div>

      {mode === "attendance" && <ManualAttendanceForm />}

      {mode === "adjust" && (
        <>
          {error && <div className="error">{error}</div>}
          {success && <div className="success">{success}</div>}
          {(pointValuesError || roster.error) && (
            <div className="warning">
              {pointValuesError && <div>Couldn't load activities/points: {pointValuesError}</div>}
              {roster.error && <div>Couldn't load the roster: {roster.error}</div>}
              <button className="secondary" style={{ marginTop: 6 }} onClick={roster.reload} disabled={roster.loading}>
                {roster.loading ? "Retrying…" : "Retry"}
              </button>
            </div>
          )}

          <div className="form-card">
        <div className="form-row">
          <label>
            Kind
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as "ep" | "gp");
                setActivitySelect("");
                setPoints("");
              }}
            >
              <option value="ep">EP (Effort Points)</option>
              <option value="gp">GP (Gear Points)</option>
            </select>
          </label>

          <label>
            Character
            <select value={characterId} onChange={(e) => setCharacterId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">— pick character —</option>
              {roster.characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.charType === "alt" && c.mainCharacterName ? ` (alt of ${c.mainCharacterName})` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        {kind === "gp" && (
          <div className="form-row">
            <label>
              Item (optional)
              <input type="text" value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="e.g. Guild Bank buy" />
            </label>
          </div>
        )}

        {kind === "ep" && (
          <div className="form-row">
            <label>
              Zone (optional)
              <input
                type="text"
                value={zone}
                onChange={(e) => setZone(e.target.value)}
                placeholder="e.g. Vex Thal — which raid this was for"
              />
            </label>
          </div>
        )}

        <div className="form-row">
          <label>
            {kind === "ep" ? "Activity" : "Tier"}
            <select value={activitySelect} onChange={(e) => onSelectActivity(e.target.value)}>
              <option value="">— pick one —</option>
              {pointValues.map((pv) => (
                <option key={pv.activity} value={pv.activity}>
                  {pv.activity} ({pv.points} pts)
                </option>
              ))}
              <option value={CUSTOM}>Custom…</option>
            </select>
          </label>

          <label>
            Points
            <input type="text" inputMode="decimal" value={points} onChange={(e) => setPoints(e.target.value)} />
          </label>
        </div>

        {activitySelect === CUSTOM && (
          <div className="form-row">
            <label>
              Custom {kind === "ep" ? "activity" : "tier"} name
              <input type="text" value={customActivity} onChange={(e) => setCustomActivity(e.target.value)} />
            </label>
          </div>
        )}

        <div className="form-row">
          <label>
            Note (optional)
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>

          <div className="form-actions">
            <button className="primary" onClick={onSubmit} disabled={pending}>
              {pending ? "Recording…" : "Record entry"}
            </button>
          </div>
        </div>
        </>
      )}
    </div>
  );
}
