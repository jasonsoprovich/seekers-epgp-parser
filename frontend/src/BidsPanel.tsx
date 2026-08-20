import { useEffect, useState } from "react";
import { CaptureBids, FetchKnownItems, SubmitBids } from "../wailsjs/go/main/App";
import { main } from "../wailsjs/go/models";
import { useRoster } from "./useRoster";

const TIERS = ["High Bid", "Medium Bid", "Low Bid", "Alt Loot"];

// Bid resolution: tier always wins first (a High Bid beats any Medium/
// Low/Alt Loot bid regardless of priority), then priority breaks ties
// within the same tier. Alt Loot ranks below Low Bid even though both
// cost 10 GP today — matches the guild's own documented tier ordering
// (docs/guild-website-feasibility.md §10: "...Low Bid > Epic Drop (Alt) >
// Alt Loot").
const TIER_RANK: Record<string, number> = { "High Bid": 4, "Medium Bid": 3, "Low Bid": 2, "Alt Loot": 1 };

type BidRow = main.BidRow & { winner: boolean };

export function BidsPanel() {
  const [itemName, setItemName] = useState("");
  const [knownItems, setKnownItems] = useState<string[]>([]);
  const [rows, setRows] = useState<BidRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [capturedItem, setCapturedItem] = useState("");
  const [submitResult, setSubmitResult] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [tieWarning, setTieWarning] = useState<string | null>(null);
  const roster = useRoster();

  // Best-effort — Settings might not be configured yet, and a missing
  // autocomplete list shouldn't block capturing bids at all.
  useEffect(() => {
    FetchKnownItems()
      .then(setKnownItems)
      .catch(() => setKnownItems([]));
  }, []);

  async function onCapture() {
    setError(null);
    setSubmitResult(null);
    setTieWarning(null);
    setPending(true);
    try {
      const result = await CaptureBids(itemName);
      setRows(result.map((r) => ({ ...r, winner: false })));
      setCapturedItem(itemName);
    } catch (err) {
      setError(String(err));
      setRows([]);
    } finally {
      setPending(false);
    }
  }

  function updateTier(index: number, tier: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, tier, ambiguous: false } : r)));
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function setWinner(index: number) {
    setTieWarning(null);
    setRows((prev) => prev.map((r, i) => ({ ...r, winner: i === index })));
  }

  function determineWinner() {
    setTieWarning(null);
    const eligible = rows
      .map((r, i) => ({ i, r, priority: roster.resolve(r.characterName).priorityRating, rank: TIER_RANK[r.tier] }))
      .filter((e) => e.rank !== undefined && e.priority !== null);

    if (eligible.length === 0) {
      setTieWarning("No row has both a resolved tier and a known priority to compare — pick a tier for each row and check the roster loaded.");
      setRows((prev) => prev.map((r) => ({ ...r, winner: false })));
      return;
    }

    const maxRank = Math.max(...eligible.map((e) => e.rank));
    const atMaxRank = eligible.filter((e) => e.rank === maxRank);
    const maxPriority = Math.max(...atMaxRank.map((e) => e.priority as number));
    const winners = atMaxRank.filter((e) => e.priority === maxPriority);

    if (winners.length > 1) {
      const names = winners.map((w) => w.r.characterName).join(", ");
      setTieWarning(`Exact tie on tier and priority between: ${names}. Pick the winner manually.`);
      setRows((prev) => prev.map((r) => ({ ...r, winner: false })));
      return;
    }

    const winnerIndex = winners[0].i;
    setRows((prev) => prev.map((r, i) => ({ ...r, winner: i === winnerIndex })));
  }

  async function onSubmit() {
    if (rows.length === 0) return;
    const invalid = rows.filter((r) => !TIERS.includes(r.tier));
    if (invalid.length > 0) {
      setError(`Pick a tier for: ${invalid.map((r) => r.characterName).join(", ")} before submitting.`);
      return;
    }
    if (rows.filter((r) => r.winner).length !== 1) {
      setError("Mark exactly one row as the winner before submitting — click Determine Winner or pick one manually.");
      return;
    }
    setSubmitting(true);
    setSubmitResult(null);
    setError(null);
    try {
      const entries = rows.map((r) => ({ characterName: r.characterName, tier: r.tier, occurredAt: r.occurredAt, isWinner: r.winner }));
      const result = await SubmitBids(capturedItem, entries);
      const notes: string[] = [];
      if (result.unmatched.length > 0) notes.push(`no character match: ${result.unmatched.join(", ")}`);
      if (result.invalidTiers.length > 0) notes.push(`invalid tier: ${result.invalidTiers.join(", ")}`);
      setSubmitResult(`Recorded ${result.inserted} bid(s) on ${capturedItem}.${notes.length > 0 ? " — " + notes.join("; ") : ""}`);
      if (result.inserted > 0) setKnownItems((prev) => (prev.includes(capturedItem) ? prev : [...prev, capturedItem].sort()));
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="panel-header">
        <h2>Bids</h2>
      </div>

      {error && <div className="error">{error}</div>}
      {tieWarning && <div className="warning">{tieWarning}</div>}
      {submitResult && <div className="success">{submitResult}</div>}
      {roster.error && <div className="warning">Couldn't load the roster for Main/Priority lookup: {roster.error}</div>}

      <div className="toolbar">
        <input
          type="text"
          list="known-items"
          placeholder="Item name (e.g. Soul Essence of Aten Ha Ra)"
          value={itemName}
          onChange={(e) => setItemName(e.target.value)}
          style={{ minWidth: 320 }}
        />
        <datalist id="known-items">
          {knownItems.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <button className="primary" onClick={onCapture} disabled={pending || !itemName.trim()}>
          {pending ? "Capturing…" : "Capture Bids"}
        </button>
      </div>

      <div className="warning">
        Say "&lt;item&gt; send tells" in guild chat first. Capture pulls every bid tell from that announcement up to now — no need to click
        anything before bids start coming in.
      </div>

      {rows.length > 0 && (
        <>
          <div className="toolbar">
            <span style={{ color: "#9ca3af", fontSize: 13 }}>
              {capturedItem} — {rows.length} bid(s)
            </span>
            <button className="secondary" onClick={determineWinner}>
              Determine Winner
            </button>
            <button className="primary" onClick={onSubmit} disabled={submitting}>
              {submitting ? "Submitting…" : "Submit to site"}
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Winner</th>
                <th>Character</th>
                <th>Main</th>
                <th>Priority</th>
                <th>Time</th>
                <th>Tier</th>
                <th>Raw message</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const resolved = roster.resolve(r.characterName);
                return (
                  <tr key={i} className={[r.ambiguous ? "ambiguous" : "", r.superseded ? "superseded" : "", r.winner ? "winner" : ""].join(" ").trim()}>
                    <td>
                      <input type="radio" name="bid-winner" checked={r.winner} onChange={() => setWinner(i)} />
                    </td>
                    <td>{r.characterName}</td>
                    <td style={{ color: resolved.matched ? "#9ca3af" : "#f87171" }}>{resolved.matched ? resolved.mainCharacterName : "no match"}</td>
                    <td style={{ color: "#9ca3af" }}>{resolved.priorityRating !== null ? resolved.priorityRating.toFixed(2) : "—"}</td>
                    <td>{new Date(r.occurredAt).toLocaleTimeString()}</td>
                    <td>
                      <select value={TIERS.includes(r.tier) ? r.tier : ""} onChange={(e) => updateTier(i, e.target.value)}>
                        {!TIERS.includes(r.tier) && (
                          <option value="" disabled>
                            {r.tier || "pick one"}
                          </option>
                        )}
                        {TIERS.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                      {r.ambiguous && <span className="badge ambiguous" style={{ marginLeft: 6 }}>needs review</span>}
                      {r.superseded && <span className="badge superseded" style={{ marginLeft: 6 }}>superseded</span>}
                    </td>
                    <td style={{ color: "#6b7280" }}>{r.rawMessage}</td>
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
        </>
      )}

      {rows.length === 0 && !error && <div className="empty">Name the item and click Capture Bids when you're ready to review.</div>}
    </div>
  );
}
