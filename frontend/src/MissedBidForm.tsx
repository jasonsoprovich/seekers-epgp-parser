import { useEffect, useState } from "react";
import { FetchKnownItems, SubmitManualBid } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";
import type { BidEntry } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/internal/officerapi/models";
import { NoMatchSelect } from "./NoMatchSelect";
import { useRoster } from "./useRoster";

const TIERS = ["High Bid", "Medium Bid", "Low Bid", "Alt Loot"];

type Row = { name: string; displayName: string; tier: string; winner: boolean };

function nowLocalInput(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

// A bid round the parser never captured — a tell missed, or the app wasn't
// running when the item dropped. Same fields a live capture collects (item,
// time, per-bidder tier + winner); posts via App.SubmitManualBid, which
// routes through the site's soft-duplicate check so re-recording something
// already on file prompts a "Record anyway" rather than silently doubling
// a GP charge.
export function MissedBidForm() {
  const [itemName, setItemName] = useState("");
  const [occurredAt, setOccurredAt] = useState(nowLocalInput);
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<Row[]>([{ name: "", displayName: "", tier: "High Bid", winner: true }]);
  const [knownItems, setKnownItems] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [dupMessage, setDupMessage] = useState<string | null>(null);
  const roster = useRoster();

  useEffect(() => {
    FetchKnownItems()
      .then((items) => setKnownItems(items ?? []))
      .catch(() => setKnownItems([]));
  }, []);

  function setRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, { name: "", displayName: "", tier: "High Bid", winner: false }]);
  }
  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function submit(confirmDuplicate: boolean) {
    setError(null);
    setSuccess(null);
    setDupMessage(null);

    const item = itemName.trim();
    if (!item) return setError("Item name is required.");
    const filled = rows.filter((r) => r.name.trim());
    if (filled.length === 0) return setError("Add at least one bidder.");
    if (!filled.some((r) => r.winner)) return setError("Mark at least one bidder as the winner.");
    const iso = new Date(occurredAt).toISOString();
    if (Number.isNaN(Date.parse(iso))) return setError("Pick a valid date/time.");

    const entries: BidEntry[] = filled.map((r) => ({
      characterName: r.name.trim(),
      tier: r.tier,
      occurredAt: "", // App.SubmitManualBid stamps every entry with `iso`
      isWinner: r.winner,
    }));

    setPending(true);
    try {
      const resp = await SubmitManualBid(item, iso, note.trim(), entries, confirmDuplicate);
      if (resp.duplicate) {
        setDupMessage(resp.duplicateMessage || `"${item}" looks like it was already recorded.`);
        return;
      }
      const unmatched = resp.unmatched ?? [];
      const invalidTiers = resp.invalidTiers ?? [];
      const notes: string[] = [];
      if (unmatched.length) notes.push(`no character match: ${unmatched.join(", ")}`);
      if (invalidTiers.length) notes.push(`invalid tier: ${invalidTiers.join(", ")}`);
      setSuccess(`Recorded ${resp.inserted} bid(s) on ${item}.${notes.length ? " — " + notes.join("; ") : ""}`);
      setRows([{ name: "", displayName: "", tier: "High Bid", winner: true }]);
      setItemName("");
      setNote("");
      if (resp.inserted > 0 && !knownItems.includes(item)) setKnownItems((k) => [...k, item].sort());
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
      {dupMessage && (
        <div className="warning">
          {dupMessage}{" "}
          <button className="secondary" style={{ marginLeft: 8 }} onClick={() => submit(true)} disabled={pending}>
            Record anyway
          </button>
        </div>
      )}

      <div className="form-row">
        <label>
          Item
          <input list="missed-bid-items" value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="e.g. Belt of the Great Turtle" />
          <datalist id="missed-bid-items">
            {knownItems.map((it) => (
              <option key={it} value={it} />
            ))}
          </datalist>
        </label>
        <label>
          When
          <input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </label>
      </div>

      <table className="col-fixed">
        <colgroup>
          <col style={{ width: "30%" }} />
          <col style={{ width: "28%" }} />
          <col style={{ width: "22%" }} />
          <col style={{ width: "10%" }} />
          <col style={{ width: "10%" }} />
        </colgroup>
        <thead>
          <tr>
            <th>Character</th>
            <th>Main</th>
            <th>Bid</th>
            <th>Winner</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const resolved = roster.resolve(r.name);
            return (
              <tr key={i}>
                <td>
                  <input
                    type="text"
                    value={r.displayName}
                    onChange={(e) => setRow(i, { name: e.target.value, displayName: e.target.value })}
                    placeholder="name from the tell"
                  />
                </td>
                <td style={{ color: resolved.matched ? "#9ca3af" : "#f87171" }}>
                  {r.name.trim() ? (
                    resolved.matched ? (
                      resolved.mainCharacterName
                    ) : (
                      <NoMatchSelect
                        name={r.displayName}
                        roster={roster}
                        onResolved={(canonical) => setRow(i, { name: canonical })}
                        onError={setError}
                      />
                    )
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <select value={r.tier} onChange={(e) => setRow(i, { tier: e.target.value })}>
                    {TIERS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </td>
                <td style={{ textAlign: "center" }}>
                  <input type="checkbox" checked={r.winner} onChange={(e) => setRow(i, { winner: e.target.checked })} />
                </td>
                <td>
                  <button className="danger" onClick={() => removeRow(i)}>
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="form-row">
        <label>
          Note (optional)
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>

      <div className="form-actions">
        <button className="secondary" onClick={addRow}>
          + Add bidder
        </button>
        <button className="primary" onClick={() => submit(false)} disabled={pending}>
          {pending ? "Recording…" : "Record bid round"}
        </button>
      </div>
    </div>
  );
}
