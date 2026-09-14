import { useEffect, useRef, useState } from "react";
import { Clipboard } from "@wailsio/runtime";
import {
  ClearAllRolls,
  GetRollSessions,
  GetRollWinnerRule,
  RemoveRollSession,
  SetRollItemName,
  SetRollWinnerRule,
  StopRollSession,
} from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";
import type { RollSessionView } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/models";
import { ConfirmDialog } from "./ConfirmDialog";

// Reference-only /random tracker — see PLAN.md's roll-tracker discussion.
// Nothing here ever leaves this app: no officerapi call, no site, no
// ledger, no GP. The officer watches rolls come in, picks a winner, and
// announces it in-game themselves; "Copy grats" just saves them retyping
// the message. Polled on a plain interval (RollsPanel is only ever
// visible/active on the Rolls tab — see App.tsx) since this is pure local
// log-tailing, not a network round trip to hide behind an event push the
// way Bids' live board needed.
const POLL_MS = 2000;

function rollsOrEmpty(s: RollSessionView): NonNullable<RollSessionView["rolls"]> {
  return s.rolls ?? [];
}

function winnersOrEmpty(s: RollSessionView): string[] {
  return s.winners ?? [];
}

function sortedRolls(s: RollSessionView, highest: boolean) {
  return rollsOrEmpty(s)
    .slice()
    .sort((a, b) => (highest ? b.value - a.value : a.value - b.value));
}

function gratsMessage(s: RollSessionView): string {
  const winners = winnersOrEmpty(s);
  const label = s.itemName.trim() || `${s.min}-${s.max} roll`;
  const winningRoll = rollsOrEmpty(s).find((r) => winners.some((w) => w.toLowerCase() === r.roller.toLowerCase()));
  const range = winningRoll ? `(${winningRoll.value}/${s.max})` : `(${s.max})`;
  return `Grats ${winners.join(" & ")} on ${label}! ${range}`;
}

function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const deltaS = Math.max(0, Math.round((now - t) / 1000));
  if (deltaS < 5) return "just now";
  if (deltaS < 60) return `${deltaS}s ago`;
  const deltaM = Math.round(deltaS / 60);
  return `${deltaM}m ago`;
}

export function RollsPanel({ active }: { active: boolean }) {
  const [sessions, setSessions] = useState<RollSessionView[]>([]);
  const [winnerRule, setWinnerRule] = useState<"highest" | "lowest">("highest");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  // Locally-edited item-name text, keyed by session id — so typing doesn't
  // fight the poll's next snapshot until the officer stops typing (a
  // simple debounce via the input's onBlur/Enter commit below).
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    GetRollWinnerRule()
      .then((rule) => setWinnerRule(rule === "lowest" ? "lowest" : "highest"))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const pollingRef = useRef(false);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    async function poll() {
      if (pollingRef.current) return; // don't overlap a slow call with the next tick
      pollingRef.current = true;
      try {
        const result = await GetRollSessions();
        if (!cancelled) {
          setSessions(result ?? []);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        pollingRef.current = false;
      }
    }
    void poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active]);

  async function onWinnerRuleChange(rule: "highest" | "lowest") {
    setWinnerRule(rule);
    try {
      await SetRollWinnerRule(rule);
    } catch (err) {
      setError(String(err));
    }
  }

  async function onStop(id: string) {
    try {
      const updated = await StopRollSession(id);
      setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
    } catch (err) {
      setError(String(err));
    }
  }

  async function onRemove(id: string) {
    try {
      await RemoveRollSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(String(err));
    }
  }

  function commitLabel(id: string) {
    const draft = labelDrafts[id];
    if (draft === undefined) return;
    void SetRollItemName(id, draft).catch((err) => setError(String(err)));
    setLabelDrafts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  async function onCopyGrats(s: RollSessionView) {
    try {
      await Clipboard.SetText(gratsMessage(s));
      setCopiedFor(s.id);
      setTimeout(() => setCopiedFor((v) => (v === s.id ? null : v)), 4000);
    } catch (err) {
      setError(String(err));
    }
  }

  async function onClearAll() {
    setClearConfirmOpen(false);
    try {
      await ClearAllRolls();
      setSessions([]);
    } catch (err) {
      setError(String(err));
    }
  }

  const highest = winnerRule === "highest";

  return (
    <div>
      <div className="panel-header">
        <h2>Rolls</h2>
        <button className="secondary" onClick={() => setClearConfirmOpen(true)} disabled={sessions.length === 0}>
          Clear all
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="toolbar">
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#9ca3af" }}>
          Winner:
          <select value={winnerRule} onChange={(e) => void onWinnerRuleChange(e.target.value as "highest" | "lowest")}>
            <option value="highest">Highest roll</option>
            <option value="lowest">Lowest roll</option>
          </select>
        </label>
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          Watches the log for <code>/random</code> — nothing here is ever submitted to the site. Announce the winner in-game
          yourself; "Copy grats" just saves the retyping.
        </span>
      </div>

      {sessions.length === 0 && !error && (
        <div className="empty">No rolls yet — say "/random &lt;max&gt;" (or "/random &lt;min&gt; &lt;max&gt;") in game and it'll show up here.</div>
      )}

      {sessions.map((s) => {
        const rolls = sortedRolls(s, highest);
        const winners = new Set(winnersOrEmpty(s).map((w) => w.toLowerCase()));
        const label = labelDrafts[s.id] ?? s.itemName;
        return (
          <div key={s.id} className={s.active ? "round-card round-card-live" : "round-card"} style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span className={s.active ? "live-pill" : "live-pill idle"}>
                <span className="live-dot" />
                {s.active ? "LIVE" : "STOPPED"}
              </span>
              <input
                type="text"
                placeholder="Item name (optional)"
                value={label}
                onChange={(e) => setLabelDrafts((prev) => ({ ...prev, [s.id]: e.target.value }))}
                onBlur={() => commitLabel(s.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitLabel(s.id);
                }}
                style={{ minWidth: 220, fontSize: 14 }}
              />
              <strong style={{ fontSize: 14, color: "#9ca3af" }}>
                {s.min}–{s.max}
              </strong>
              <span style={{ color: "#9ca3af", fontSize: 13 }}>
                {rolls.length} roll{rolls.length === 1 ? "" : "s"} · last {relativeTime(s.lastRollAt, now)}
              </span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                {s.active && (
                  <button className="primary" onClick={() => void onStop(s.id)}>
                    Determine Winner
                  </button>
                )}
                <button className="secondary" onClick={() => void onRemove(s.id)}>
                  Remove
                </button>
              </span>
            </div>

            {winners.size > 0 && (
              <div className="winner-summary" style={{ marginTop: 10 }}>
                <div>
                  <strong>Winner{winners.size > 1 ? "s" : ""}:</strong> {gratsMessage(s)}
                </div>
                <span style={{ color: "#9ca3af", fontSize: 12, flexShrink: 0 }}>
                  {copiedFor === s.id ? "Copied ✓" : ""}
                  <button className="secondary" style={{ marginLeft: 8 }} onClick={() => void onCopyGrats(s)}>
                    Copy grats
                  </button>
                </span>
              </div>
            )}

            {rolls.length > 0 && (
              <table className="col-fixed" style={{ marginTop: 10 }}>
                <colgroup>
                  <col style={{ width: "30%" }} />
                  <col style={{ width: "20%" }} />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th>Roller</th>
                    <th>Roll</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {rolls.map((r, i) => {
                    const isWinner = !s.active && winners.has(r.roller.toLowerCase());
                    const isLeading = s.active && !r.duplicate && i === 0;
                    return (
                      <tr
                        key={`${r.roller}-${r.occurredAt}-${i}`}
                        className={[r.duplicate ? "superseded" : "", isWinner ? "winner" : "", isLeading ? "leading" : ""].join(" ").trim()}
                      >
                        <td>
                          {isWinner && <span style={{ marginRight: 6 }}>🏆</span>}
                          {r.roller}
                        </td>
                        <td>
                          {r.value}
                          {isLeading && (
                            <span className="badge leading" style={{ marginLeft: 6 }}>
                              leading
                            </span>
                          )}
                          {r.duplicate && (
                            <span className="badge superseded" style={{ marginLeft: 6 }}>
                              reroll
                            </span>
                          )}
                        </td>
                        <td style={{ color: "#9ca3af" }}>{new Date(r.occurredAt).toLocaleTimeString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })}

      <ConfirmDialog
        open={clearConfirmOpen}
        title="Clear all rolls?"
        confirmLabel="Clear all"
        onCancel={() => setClearConfirmOpen(false)}
        onConfirm={() => void onClearAll()}
        body={
          <p style={{ margin: 0 }}>
            This hides every roll session tracked so far. A new <code>/random</code> starts fresh — nothing was ever recorded
            anywhere, so there's nothing to undo either way.
          </p>
        }
      />
    </div>
  );
}
