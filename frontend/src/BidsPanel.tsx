import { useEffect, useState } from "react";
import { CaptureBids, FetchKnownItems, SubmitBids } from "../wailsjs/go/main/App";
import { ClipboardSetText } from "../wailsjs/runtime/runtime";
import { main } from "../wailsjs/go/models";
import { NoMatchSelect } from "./NoMatchSelect";
import { useRoster } from "./useRoster";

const TIERS = ["High Bid", "Medium Bid", "Low Bid", "Alt Loot"];

// Bid resolution: tier always wins first (a High Bid beats any Medium/
// Low/Alt Loot bid regardless of priority), then priority breaks ties
// within the same tier. Alt Loot ranks below Low Bid even though both
// cost 10 GP today — matches the guild's own documented tier ordering
// (docs/guild-website-feasibility.md §10: "...Low Bid > Epic Drop (Alt) >
// Alt Loot").
const TIER_RANK: Record<string, number> = { "High Bid": 4, "Medium Bid": 3, "Low Bid": 2, "Alt Loot": 1 };

// `characterName` is the resolution/submission identity — it's what gets
// looked up against the roster and sent to the site. `displayName` is
// frozen at capture time and always shown in the Character column, so
// resolving an unmatched row (e.g. linking "Leighi" as a new alt of main
// "Tiliki") doesn't overwrite the captured name the officer recognizes —
// the Main column is where the resolved main shows up instead.
type BidRow = main.BidRow & { winner: boolean; displayName: string };

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
  const [winnerCount, setWinnerCount] = useState(1);
  const [gratsCopied, setGratsCopied] = useState(false);
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
      setRows(result.map((r) => ({ ...r, winner: false, displayName: r.characterName })));
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

  function resolveIdentity(index: number, characterName: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, characterName } : r)));
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function toggleWinner(index: number) {
    setTieWarning(null);
    setGratsCopied(false);
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, winner: !r.winner } : r)));
  }

  // Picks the top `winnerCount` bids by tier rank then priority — covers
  // a duplicate drop (same item, multiple copies) with more than one
  // winner. If the cutoff between the last included and first excluded
  // bid is an exact tie on both tier and priority, nothing is
  // auto-selected — that's a real ambiguity the officer has to resolve by
  // hand (checking the boxes directly), not something to guess at.
  function determineWinner() {
    setTieWarning(null);
    setGratsCopied(false);
    const eligible = rows
      .map((r, i) => ({ i, r, priority: roster.resolve(r.characterName).priorityRating, rank: TIER_RANK[r.tier] }))
      .filter((e): e is { i: number; r: BidRow; priority: number; rank: number } => e.rank !== undefined && e.priority !== null);

    if (eligible.length === 0) {
      setTieWarning("No row has both a resolved tier and a known priority to compare — pick a tier for each row and check the roster loaded.");
      setRows((prev) => prev.map((r) => ({ ...r, winner: false })));
      return;
    }

    const sorted = eligible.slice().sort((a, b) => b.rank - a.rank || b.priority - a.priority);
    const n = Math.min(Math.max(1, winnerCount), sorted.length);
    const cutoff = sorted[n - 1];
    const nextAfterCutoff = sorted[n];

    if (nextAfterCutoff && nextAfterCutoff.rank === cutoff.rank && nextAfterCutoff.priority === cutoff.priority) {
      const tied = sorted
        .filter((e) => e.rank === cutoff.rank && e.priority === cutoff.priority)
        .map((e) => e.r.characterName)
        .join(", ");
      setTieWarning(`Exact tie on tier and priority at the cutoff for winner #${n}, between: ${tied}. Check the winner box(es) manually.`);
      setRows((prev) => prev.map((r) => ({ ...r, winner: false })));
      return;
    }

    const winnerIndices = new Set(sorted.slice(0, n).map((e) => e.i));
    setRows((prev) => prev.map((r, i) => ({ ...r, winner: winnerIndices.has(i) })));
  }

  function gratsMessage(winners: BidRow[]): string {
    return `Grats ${winners.map((r) => r.characterName).join(", ")} on ${capturedItem}!`;
  }

  async function onCopyGrats() {
    const winners = rows.filter((r) => r.winner);
    if (winners.length === 0) return;
    await ClipboardSetText(gratsMessage(winners));
    setGratsCopied(true);
  }

  async function onSubmit() {
    if (rows.length === 0) return;
    const invalid = rows.filter((r) => !TIERS.includes(r.tier));
    if (invalid.length > 0) {
      setError(`Pick a tier for: ${invalid.map((r) => r.characterName).join(", ")} before submitting.`);
      return;
    }
    if (rows.filter((r) => r.winner).length === 0) {
      setError("Mark at least one row as the winner before submitting — click Determine Winner or check one manually.");
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
      const lostCount = result.inserted - winners.length;
      setSubmitResult(
        `Recorded ${result.inserted} bid(s) on ${capturedItem} — ${winners.length} won (GP charged), ${lostCount} lost (no GP charge).${notes.length > 0 ? " — " + notes.join("; ") : ""}`,
      );
      if (result.inserted > 0) setKnownItems((prev) => (prev.includes(capturedItem) ? prev : [...prev, capturedItem].sort()));
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const winners = rows.filter((r) => r.winner);

  return (
    <div>
      <div className="panel-header">
        <h2>Bids</h2>
      </div>

      {error && <div className="error">{error}</div>}
      {tieWarning && <div className="warning">{tieWarning}</div>}
      {submitResult && <div className="success">{submitResult}</div>}
      {roster.error && <div className="warning">Couldn't load the roster for Main/Priority lookup: {roster.error}</div>}

      {winners.length > 0 && (
        <div className="winner-summary">
          <div>
            <strong>Winner{winners.length > 1 ? "s" : ""}:</strong> {gratsMessage(winners)}
          </div>
          <button className="secondary" onClick={onCopyGrats}>
            {gratsCopied ? "Copied" : "Copy Grats Message"}
          </button>
        </div>
      )}

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
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#9ca3af" }}>
              Winners:
              <input
                type="text"
                inputMode="numeric"
                value={winnerCount}
                onChange={(e) => setWinnerCount(Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1))}
                style={{ width: 40, textAlign: "center" }}
                title="How many winners to pick — more than 1 for a duplicate drop"
              />
            </label>
            <button className="secondary" onClick={determineWinner}>
              Determine Winner{winnerCount > 1 ? "s" : ""}
            </button>
            <button className="primary" onClick={onSubmit} disabled={submitting}>
              {submitting ? "Submitting…" : "Submit to site"}
            </button>
          </div>
          <table className="col-fixed">
            <colgroup>
              <col style={{ width: "14%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "14%" }} />
              <col />
              <col style={{ width: "8%" }} />
            </colgroup>
            <thead>
              <tr>
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
                  <tr
                    key={i}
                    className={[r.ambiguous ? "ambiguous" : "", r.superseded ? "superseded" : "", r.winner ? "winner" : ""].join(" ").trim()}
                    onClick={() => toggleWinner(i)}
                    style={{ cursor: "pointer" }}
                    title="Click the row to mark/unmark this bid as a winner"
                  >
                    <td>{r.displayName}</td>
                    <td onClick={(e) => e.stopPropagation()} style={{ color: resolved.matched ? "#9ca3af" : "#f87171" }}>
                      {resolved.matched ? (
                        resolved.mainCharacterName
                      ) : (
                        <NoMatchSelect
                          name={r.displayName}
                          roster={roster}
                          onResolved={(canonicalName) => resolveIdentity(i, canonicalName)}
                          onError={setError}
                        />
                      )}
                    </td>
                    <td style={{ color: "#9ca3af" }}>{resolved.priorityRating !== null ? resolved.priorityRating.toFixed(2) : "—"}</td>
                    <td>{new Date(r.occurredAt).toLocaleTimeString()}</td>
                    <td onClick={(e) => e.stopPropagation()}>
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
                    <td onClick={(e) => e.stopPropagation()}>
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
