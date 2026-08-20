import { useState } from "react";
import { StartBidCapture, StopBidCapture, SubmitBids } from "../wailsjs/go/main/App";
import { ClipboardSetText } from "../wailsjs/runtime/runtime";
import { main } from "../wailsjs/go/models";

const TIERS = ["High Bid", "Medium Bid", "Low Bid", "Alt Loot"];

export function BidsPanel() {
  const [itemName, setItemName] = useState("");
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<main.BidRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [capturedItem, setCapturedItem] = useState("");
  const [submitResult, setSubmitResult] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onStart() {
    setError(null);
    setPending(true);
    try {
      await StartBidCapture(itemName);
      setOpen(true);
      setRows([]);
      setCopied(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  }

  async function onStop() {
    setPending(true);
    setError(null);
    setSubmitResult(null);
    try {
      const result = await StopBidCapture();
      setRows(result);
      setCapturedItem(itemName);
      setOpen(false);
      setItemName("");
    } catch (err) {
      setError(String(err));
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

  async function onCopy() {
    const lines = rows.map((r) => `${r.characterName}\t${r.tier}\t${r.occurredAt}`);
    await ClipboardSetText(`${capturedItem}\n${lines.join("\n")}`);
    setCopied(true);
  }

  async function onSubmit() {
    if (rows.length === 0) return;
    const invalid = rows.filter((r) => !TIERS.includes(r.tier));
    if (invalid.length > 0) {
      setError(`Pick a tier for: ${invalid.map((r) => r.characterName).join(", ")} before submitting.`);
      return;
    }
    setSubmitting(true);
    setSubmitResult(null);
    setError(null);
    try {
      const entries = rows.map((r) => ({ characterName: r.characterName, tier: r.tier, occurredAt: r.occurredAt }));
      const result = await SubmitBids(capturedItem, entries);
      const notes: string[] = [];
      if (result.unmatched.length > 0) notes.push(`no character match: ${result.unmatched.join(", ")}`);
      if (result.invalidTiers.length > 0) notes.push(`invalid tier: ${result.invalidTiers.join(", ")}`);
      setSubmitResult(`Charged GP for ${result.inserted} bid(s) on ${capturedItem}.${notes.length > 0 ? " — " + notes.join("; ") : ""}`);
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
      {submitResult && <div className="success">{submitResult}</div>}

      <div className="toolbar">
        <input
          type="text"
          placeholder="Item name (e.g. Soul Essence of Aten Ha Ra)"
          value={itemName}
          onChange={(e) => setItemName(e.target.value)}
          disabled={open}
          style={{ minWidth: 320 }}
        />
        {!open ? (
          <button className="primary" onClick={onStart} disabled={pending || !itemName.trim()}>
            Start
          </button>
        ) : (
          <button className="primary" onClick={onStop} disabled={pending}>
            {pending ? "Stopping…" : "Stop / Lock In"}
          </button>
        )}
      </div>

      {open && <div className="warning">Collecting tells for "{itemName}" — click Stop / Lock In when done.</div>}

      {!open && rows.length > 0 && (
        <>
          <div className="toolbar">
            <span style={{ color: "#9ca3af", fontSize: 13 }}>
              {capturedItem} — {rows.length} bid(s)
            </span>
            <button className="primary" onClick={onSubmit} disabled={submitting}>
              {submitting ? "Submitting…" : "Submit to site"}
            </button>
            <button className="secondary" onClick={onCopy}>
              {copied ? "Copied" : "Copy to clipboard"}
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Character</th>
                <th>Time</th>
                <th>Tier</th>
                <th>Raw message</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={[r.ambiguous ? "ambiguous" : "", r.superseded ? "superseded" : ""].join(" ").trim()}>
                  <td>{r.characterName}</td>
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
              ))}
            </tbody>
          </table>
        </>
      )}

      {!open && rows.length === 0 && !error && (
        <div className="empty">Name the item and click Start when you're ready to collect tells.</div>
      )}
    </div>
  );
}
