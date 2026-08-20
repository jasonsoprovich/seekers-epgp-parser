import { useEffect, useState } from "react";
import { FetchPointValues, SubmitManualEntry } from "../wailsjs/go/main/App";
import { officerapi } from "../wailsjs/go/models";
import { useRoster } from "./useRoster";

const CUSTOM = "__custom__";

// Journal-entry style: guild-bank donations, level/epic milestones, ad-hoc
// adjustments — anything that isn't attendance or a bid. Posts straight to
// /api/officer/manual-entry (already used by the website's own ledger
// form) with the current time as occurredAt; there's no backdating field
// on purpose, matching "use the current time as the timestamp."
export function ManualEntryPanel() {
  const [kind, setKind] = useState<"ep" | "gp">("ep");
  const [pointValues, setPointValues] = useState<officerapi.PointValue[]>([]);
  const [characterId, setCharacterId] = useState<number | "">("");
  const [activitySelect, setActivitySelect] = useState("");
  const [customActivity, setCustomActivity] = useState("");
  const [itemName, setItemName] = useState("");
  const [points, setPoints] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const roster = useRoster();

  useEffect(() => {
    FetchPointValues()
      .then((pv) => setPointValues(kind === "ep" ? pv.ep : pv.gp))
      .catch((err) => setError(String(err)));
  }, [kind]);

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
        points: pointsNum,
        occurredAt: new Date().toISOString(),
        note: note.trim(),
      });
      const characterName = roster.characters.find((c) => c.id === characterId)?.name ?? "character";
      setSuccess(`Recorded ${pointsNum} ${kind.toUpperCase()} for ${characterName} (${activity}).`);
      setPoints("");
      setNote("");
      setItemName("");
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
      </div>

      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}
      {roster.error && <div className="warning">Couldn't load the roster: {roster.error}</div>}

      <div className="form-grid" style={{ maxWidth: 480 }}>
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

        {kind === "gp" && (
          <label>
            Item (optional)
            <input type="text" value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="e.g. Guild Bank buy" />
          </label>
        )}

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

        {activitySelect === CUSTOM && (
          <label>
            Custom {kind === "ep" ? "activity" : "tier"} name
            <input type="text" value={customActivity} onChange={(e) => setCustomActivity(e.target.value)} />
          </label>
        )}

        <label>
          Points
          <input type="text" inputMode="decimal" value={points} onChange={(e) => setPoints(e.target.value)} />
        </label>

        <label>
          Note (optional)
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>

      <div className="toolbar">
        <button className="primary" onClick={onSubmit} disabled={pending}>
          {pending ? "Recording…" : "Record entry"}
        </button>
      </div>
    </div>
  );
}
