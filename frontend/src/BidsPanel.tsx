import { useEffect, useMemo, useRef, useState } from "react";
import { Clipboard, Events } from "@wailsio/runtime";
import { CaptureBids, DiscardBidRound, EndBidRound, FetchKnownItems, SubmitBids } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";
import type { BidRound, BidRow as CapturedBidRow } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/models";
import { NoMatchSelect } from "./NoMatchSelect";
import { useRoster } from "./useRoster";

const TIERS = ["High Bid", "Medium Bid", "Low Bid", "Alt Loot", "Rot (No-Drop)"];

// Bid resolution: tier always wins first (a High Bid beats any Medium/
// Low/Alt Loot bid regardless of priority), then priority breaks ties
// within the same tier. Alt Loot ranks below Low Bid even though both
// cost 10 GP today — matches the guild's own documented tier ordering
// (docs/guild-website-feasibility.md §10: "...Low Bid > Epic Drop (Alt) >
// Alt Loot").
// Rot (No-Drop) ranks below Alt Loot — it's a no-one-wanted-it cleanup
// claim, never competing for a real drop. All three of Low/Alt/Rot cost 10
// GP; the ordering only matters for Determine Winner tie-breaks.
const TIER_RANK: Record<string, number> = { "High Bid": 4, "Medium Bid": 3, "Low Bid": 2, "Alt Loot": 1, "Rot (No-Drop)": 0 };

// `characterName` is the resolution/submission identity — it's what gets
// looked up against the roster and sent to the site. `displayName` is
// frozen at capture time and always shown in the Character column, so
// resolving an unmatched row (e.g. linking "Leighi" as a new alt of main
// "Tiliki") doesn't overwrite the captured name the officer recognizes —
// the Main column is where the resolved main shows up instead.
// `manual` marks a row the officer added by hand in the review step — a
// bid the parser never caught (a tell it missed, or one called out on
// voice). It's editable the same as a captured row but its Character cell
// is a free text input rather than frozen capture text. This is the only
// place a "missed bid" is entered now: after End Round & Review, before
// Submit — a bid recorded after the item's already been awarded is useless
// because the item can't be traded anymore.
type BidRow = CapturedBidRow & { winner: boolean; displayName: string; manual?: boolean };

// idle: nothing running, the manual "name it + Capture" escape hatch is shown.
// live: a round is tracking; the table refreshes itself from "bids:round"
//       events every few seconds and nothing is editable yet.
// review: the officer clicked End Round & Review — the table is frozen and
//       editable, Determine Winner / Submit apply.
type Phase = "idle" | "live" | "review";

function toReviewRows(round: BidRound | null): BidRow[] {
  return (round?.rows ?? []).map((r) => ({ ...r, winner: false, displayName: r.characterName }));
}

// Which rows are superseded by a later bid from the same person — recomputed
// from the current table every render rather than trusting the Go
// `superseded` flag alone, so adding or *removing* a manually added row
// re-decides who the active bid is (remove the newer row and the older one
// comes back). Identity is the resolved main when known (an alt's bid and
// the main's bid are one person), else the typed name; a blank manual row
// isn't comparable yet. Within a group the newest bid by timestamp wins,
// ties broken by table order (a manual row is appended last, so it's
// newest). Only the active bid per person feeds Determine Winner and the
// submit payload — the guild rule is "a later tell means changed my mind".
function supersededRowIndices(rows: BidRow[], resolve: (name: string) => { matched: boolean; mainCharacterName: string | null }): Set<number> {
  const groups = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const name = r.characterName.trim();
    if (!name) return;
    const res = resolve(name);
    const key = (res.matched && res.mainCharacterName ? res.mainCharacterName : name).toLowerCase();
    const arr = groups.get(key);
    if (arr) arr.push(i);
    else groups.set(key, [i]);
  });

  const superseded = new Set<number>();
  const score = (i: number) => {
    const t = Date.parse(rows[i].occurredAt);
    return Number.isNaN(t) ? -Infinity : t;
  };
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    let winner = idxs[0];
    for (const i of idxs) {
      if (score(i) > score(winner) || (score(i) === score(winner) && i > winner)) winner = i;
    }
    for (const i of idxs) if (i !== winner) superseded.add(i);
  }
  return superseded;
}

export function BidsPanel() {
  const [itemName, setItemName] = useState("");
  const [knownItems, setKnownItems] = useState<string[]>([]);
  const [rows, setRows] = useState<BidRow[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [capturedItem, setCapturedItem] = useState("");
  const [roundStartedAt, setRoundStartedAt] = useState<string>("");
  const [submitResult, setSubmitResult] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [tieWarning, setTieWarning] = useState<string | null>(null);
  const [winnerCount, setWinnerCount] = useState(1);
  const [gratsCopied, setGratsCopied] = useState(false);
  // A "send tells" the watcher detected while a round is already under
  // way — shown as a switch/dismiss banner rather than clobbering the
  // in-progress round. Null when there's nothing pending.
  const [pendingAnnouncement, setPendingAnnouncement] = useState<{ item: string; announcedAt: string } | null>(null);
  // Toast shown briefly when a round auto-starts from a detected announcement.
  const [autoStarted, setAutoStarted] = useState<string | null>(null);
  const roster = useRoster();

  // Recomputed on every row/roster change — see supersededRowIndices. Used
  // by Determine Winner, Submit, and the row styling so a superseded bid is
  // shown (dimmed) but never wins or gets sent to the site.
  const supersededSet = useMemo(
    () => supersededRowIndices(rows, (name) => roster.resolve(name)),
    [rows, roster.characters], // roster.resolve closes over the same index roster.characters drives
  );

  // Best-effort — Settings might not be configured yet, and a missing
  // autocomplete list shouldn't block capturing bids at all.
  useEffect(() => {
    FetchKnownItems()
      .then((items) => setKnownItems(items ?? []))
      .catch(() => setKnownItems([]));
  }, []);

  // Read the live phase from a ref inside the once-registered listeners so
  // they see the current value without re-subscribing on every change.
  const phaseRef = useRef<Phase>("idle");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // PLAN.md §15 — the app watches the log for the officer's own
  // "<item> send tells" and fires this so a round auto-starts without them
  // typing the item name or clicking Capture. If a round's already under
  // way, don't clobber it — offer a switch instead.
  useEffect(() => {
    return Events.On("bids:announcement", (ev: { data?: { itemName?: string; announcedAt?: string } }) => {
      const item = ev?.data?.itemName?.trim();
      if (!item) return;
      if (phaseRef.current !== "idle") {
        setPendingAnnouncement({ item, announcedAt: ev?.data?.announcedAt ?? "" });
        return;
      }
      setItemName(item);
      // Pass the detected line's timestamp — CaptureBids anchors the window
      // to exactly it, so a re-announcement can't fold in a finished round.
      void captureFor(item, ev?.data?.announcedAt ?? "");
      setAutoStarted(item);
      setTimeout(() => setAutoStarted((v) => (v === item ? null : v)), 8000);
    });
  }, []);

  // While a round is live the Go-side poller re-emits the whole round every
  // few seconds as tells arrive. Replace the table wholesale — nothing is
  // editable in this phase, so there's nothing to merge or clobber.
  useEffect(() => {
    return Events.On("bids:round", (ev: { data?: BidRound }) => {
      if (phaseRef.current !== "live") return;
      const round = ev?.data;
      if (!round?.live) return;
      setRows(toReviewRows(round));
      setCapturedItem(round.itemName);
      setRoundStartedAt(round.startedAt);
    });
  }, []);

  async function captureFor(name: string, announcedAt = "") {
    const target = name.trim();
    if (!target) return;
    setError(null);
    setSubmitResult(null);
    setTieWarning(null);
    setPendingAnnouncement(null);
    setPending(true);
    try {
      const round = await CaptureBids(target, announcedAt);
      setRows(toReviewRows(round));
      setCapturedItem(round.itemName);
      setRoundStartedAt(round.startedAt);
      setPhase("live");
    } catch (err) {
      setError(String(err));
      setRows([]);
      setPhase("idle");
    } finally {
      setPending(false);
    }
  }

  function onCapture() {
    void captureFor(itemName);
  }

  async function onEndRound() {
    setPending(true);
    setError(null);
    try {
      const round = await EndBidRound();
      setRows(toReviewRows(round));
      if (round.itemName) setCapturedItem(round.itemName);
      setPhase("review");
    } catch (err) {
      // The round still ended server-side; surface the error but let the
      // officer review whatever rows came back.
      setError(String(err));
      setPhase("review");
    } finally {
      setPending(false);
    }
  }

  function resetToIdle() {
    setRows([]);
    setPhase("idle");
    setCapturedItem("");
    setRoundStartedAt("");
    setItemName("");
    setTieWarning(null);
    setGratsCopied(false);
  }

  // Explicit reset — a live/review round now survives a tab switch
  // (App.tsx keeps panels mounted), so the officer needs a deliberate way
  // to throw it away. Also clears the site's live round and any stale
  // error/result/announcement banners.
  function onClear() {
    // Best-effort clear of the site's live round too — a cleared round
    // shouldn't linger on /live-bids.
    void DiscardBidRound().catch(() => {});
    resetToIdle();
    setError(null);
    setSubmitResult(null);
    setPendingAnnouncement(null);
    setAutoStarted(null);
  }

  const canClear = phase !== "idle" || error !== null || submitResult !== null || pendingAnnouncement !== null;

  function updateTier(index: number, tier: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, tier, ambiguous: false } : r)));
  }

  function resolveIdentity(index: number, characterName: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, characterName } : r)));
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  // Add a blank row for a bid the capture missed. Stamped with the current
  // time (not the round start) so it counts as this person's newest bid —
  // if they already have a captured tell, this manual entry supersedes it
  // (supersededRowIndices), matching "a later bid means changed my mind".
  // Still inside the raid-night window the site's bids route accepts. Tier
  // defaults to High Bid; the name is a combobox over the roster (pick an
  // alt and the Main column fills itself) that also takes a free-typed
  // name, resolved exactly like a captured row.
  function addManualRow() {
    setTieWarning(null);
    setGratsCopied(false);
    setRows((prev) => [
      ...prev,
      {
        characterName: "",
        displayName: "",
        tier: "High Bid",
        occurredAt: new Date().toISOString(),
        ambiguous: false,
        rawMessage: "(added manually)",
        superseded: false,
        cancelRequested: false,
        winner: false,
        manual: true,
      },
    ]);
  }

  function setManualName(index: number, name: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, characterName: name, displayName: name } : r)));
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
  const [determining, setDetermining] = useState(false);

  async function determineWinner() {
    setTieWarning(null);
    setGratsCopied(false);
    // Pull a fresh roster first: if another officer finalized an item
    // seconds ago, the winner's GP is already charged and their priority
    // has dropped. Using the app-startup roster cache here would let a
    // high-priority main sweep a second item off a stale number. Falls
    // back to the cached resolver if the refetch fails.
    let resolvePriority = roster.resolve;
    setDetermining(true);
    try {
      resolvePriority = await roster.refetch();
    } catch {
      // stale-cache fallback — better than blocking the officer entirely
    } finally {
      setDetermining(false);
    }

    const eligible = rows
      .map((r, i) => ({ i, r, priority: resolvePriority(r.characterName).priorityRating, rank: TIER_RANK[r.tier] }))
      .filter((e): e is { i: number; r: BidRow; priority: number; rank: number } =>
        // A bid the bidder asked to cancel isn't auto-picked — the officer
        // decides whether it stands (and can still check its box by hand).
        !supersededSet.has(e.i) && !e.r.cancelRequested && e.rank !== undefined && e.priority !== null,
      );

    if (eligible.length === 0) {
      setTieWarning("No active row has both a resolved tier and a known priority to compare — pick a tier for each row and check the roster loaded.");
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
    if (winners.length === 0) return;
    await Clipboard.SetText(gratsMessage(winners));
    setGratsCopied(true);
  }

  async function onSubmit() {
    if (rows.length === 0) return;
    // A bid superseded by a later one from the same person is never sent —
    // only the person's active bid is recorded (guild rule: last tell wins).
    const activeRows = rows.filter((_, i) => !supersededSet.has(i));
    const invalid = activeRows.filter((r) => !TIERS.includes(r.tier));
    if (invalid.length > 0) {
      setError(`Pick a tier for: ${invalid.map((r) => r.characterName || "(unnamed row)").join(", ")} before submitting.`);
      return;
    }
    const activeWinners = activeRows.filter((r) => r.winner);
    if (activeWinners.length === 0) {
      setError("Mark at least one row as the winner before submitting — click Determine Winner or check one manually.");
      return;
    }
    const blankManual = activeRows.filter((r) => !r.characterName.trim());
    if (blankManual.length > 0) {
      setError("Fill in the character name for every manually added row, or remove it.");
      return;
    }
    setSubmitting(true);
    setSubmitResult(null);
    setError(null);
    try {
      const entries = activeRows.map((r) => ({ characterName: r.characterName, tier: r.tier, occurredAt: r.occurredAt, isWinner: r.winner }));
      const result = await SubmitBids(capturedItem, entries);
      const notes: string[] = [];
      const unmatched = result.unmatched ?? [];
      const invalidTiers = result.invalidTiers ?? [];
      if (unmatched.length > 0) notes.push(`no character match: ${unmatched.join(", ")}`);
      if (invalidTiers.length > 0) notes.push(`invalid tier: ${invalidTiers.join(", ")}`);
      const supersededCount = rows.length - activeRows.length;
      if (supersededCount > 0) notes.push(`${supersededCount} superseded bid(s) not sent`);
      const lostCount = result.inserted - activeWinners.length;
      setSubmitResult(
        `Recorded ${result.inserted} bid(s) on ${capturedItem} — ${activeWinners.length} won (GP charged), ${lostCount} lost (no GP charge).${notes.length > 0 ? " — " + notes.join("; ") : ""}`,
      );
      if (result.inserted > 0) setKnownItems((prev) => (prev.includes(capturedItem) ? prev : [...prev, capturedItem].sort()));
      resetToIdle();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const winners = rows.filter((r, i) => r.winner && !supersededSet.has(i));
  const startedLabel = roundStartedAt ? new Date(roundStartedAt).toLocaleTimeString() : "";

  return (
    <div>
      <div className="panel-header">
        <h2>Bids</h2>
        <button className="secondary" onClick={onClear} disabled={submitting || pending || !canClear}>
          Clear
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {tieWarning && <div className="warning">{tieWarning}</div>}
      {submitResult && <div className="success">{submitResult}</div>}
      {roster.error && (
        <div className="warning">
          Couldn't load the roster for Main/Priority lookup: {roster.error}{" "}
          <button className="secondary" style={{ marginLeft: 8 }} onClick={roster.reload} disabled={roster.loading}>
            {roster.loading ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}

      {phase === "review" && winners.length > 0 && (
        <div className="winner-summary">
          <div>
            <strong>Winner{winners.length > 1 ? "s" : ""}:</strong> {gratsMessage(winners)}
          </div>
          <button className="secondary" onClick={onCopyGrats}>
            {gratsCopied ? "Copied" : "Copy Grats Message"}
          </button>
        </div>
      )}

      {phase === "idle" && (
        <>
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
              {pending ? "Starting…" : "Capture Bids"}
            </button>
          </div>

          <div className="warning">
            Say "&lt;item&gt; send tells" in guild chat — the app starts tracking that round automatically and pushes bids to the site live.
            No need to type the item or click Capture (that button is here for when you announced before opening the app).
          </div>
        </>
      )}

      {autoStarted && (
        <div className="success">
          Auto-started bids for <strong>{autoStarted}</strong> from your announcement. It's tracking live now — click End Round &amp; Review
          when calls are done.
        </div>
      )}

      {pendingAnnouncement && (
        <div className="warning" style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between" }}>
          <span>
            <strong>{pendingAnnouncement.item}</strong> was announced again. Finish the current round first, or switch now (discards the
            current one).
          </span>
          <span style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button
              className="primary"
              onClick={() => {
                const next = pendingAnnouncement;
                setPendingAnnouncement(null);
                setPhase("idle");
                setItemName(next.item);
                void captureFor(next.item, next.announcedAt);
              }}
            >
              Switch
            </button>
            <button className="secondary" onClick={() => setPendingAnnouncement(null)}>
              Ignore
            </button>
          </span>
        </div>
      )}

      {(phase === "live" || phase === "review") && (
        <div className={phase === "live" ? "round-card round-card-live" : "round-card"}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className={phase === "live" ? "live-pill" : "live-pill idle"}>
              <span className="live-dot" />
              {phase === "live" ? "LIVE" : "REVIEW"}
            </span>
            <strong style={{ fontSize: 15 }}>{capturedItem || "—"}</strong>
            <span style={{ color: "#9ca3af", fontSize: 13 }}>
              {startedLabel && `started ${startedLabel} · `}
              {rows.length} bid{rows.length === 1 ? "" : "s"}
              {phase === "live" && " · watching…"}
            </span>
            {phase === "live" && (
              <button className="primary" style={{ marginLeft: "auto" }} onClick={onEndRound} disabled={pending}>
                {pending ? "Ending…" : "End Round & Review"}
              </button>
            )}
          </div>
        </div>
      )}

      {phase === "review" && rows.length > 0 && (
        <div className="toolbar">
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
          <button className="secondary" onClick={() => void determineWinner()} disabled={determining}>
            {determining ? "Checking priority…" : `Determine Winner${winnerCount > 1 ? "s" : ""}`}
          </button>
          <button className="secondary" onClick={addManualRow} title="Add a bid the capture missed — before you Submit">
            + Add bid manually
          </button>
          <button
            className="primary"
            onClick={onSubmit}
            disabled={submitting || winners.length === 0}
            title={winners.length === 0 ? "Pick a winner first — Determine Winner, or click a row" : undefined}
          >
            {submitting ? "Submitting…" : "Submit to site"}
          </button>
          <button className="secondary" onClick={onClear} disabled={submitting}>
            Clear
          </button>
        </div>
      )}

      {phase === "review" && rows.length === 0 && (
        <div className="toolbar">
          <button className="secondary" onClick={addManualRow}>
            + Add bid manually
          </button>
          <button className="secondary" onClick={onClear} disabled={submitting}>
            Clear
          </button>
        </div>
      )}

      <datalist id="bid-known-characters">
        {roster.characters.map((c) => (
          <option key={c.id} value={c.name} />
        ))}
      </datalist>

      {(phase === "live" || phase === "review") && rows.length > 0 && (
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
              const live = phase === "live";
              const isSuperseded = supersededSet.has(i);
              const cancelReq = !!r.cancelRequested && !isSuperseded;
              const rowClickable = !live && !isSuperseded;
              return (
                <tr
                  key={i}
                  className={[
                    r.ambiguous || cancelReq ? "ambiguous" : "",
                    isSuperseded ? "superseded" : "",
                    r.winner && !isSuperseded ? "winner" : "",
                  ]
                    .join(" ")
                    .trim()}
                  onClick={rowClickable ? () => toggleWinner(i) : undefined}
                  style={{ cursor: rowClickable ? "pointer" : "default" }}
                  title={
                    live
                      ? undefined
                      : isSuperseded
                        ? "Superseded by a later bid from the same person — remove the newer row to bring this one back"
                        : cancelReq
                          ? "This bidder said “cancel my bid” — decide whether to Remove it or keep it, then pick the winner"
                          : "Click the row to mark/unmark this bid as a winner"
                  }
                >
                  <td onClick={r.manual && !live ? (e) => e.stopPropagation() : undefined}>
                    {r.manual && !live ? (
                      <input
                        type="text"
                        className="cell-input"
                        list="bid-known-characters"
                        value={r.displayName}
                        placeholder="pick or type a character"
                        onChange={(e) => setManualName(i, e.target.value)}
                      />
                    ) : (
                      r.displayName
                    )}
                  </td>
                  <td onClick={(e) => e.stopPropagation()} style={{ color: resolved.matched ? "#9ca3af" : "#f87171" }}>
                    {resolved.matched ? (
                      resolved.mainCharacterName
                    ) : live ? (
                      <span style={{ color: "#f87171" }}>no match</span>
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
                    {live ? (
                      <span style={{ color: r.ambiguous ? "#fbbf24" : "#d1d5db" }}>{r.tier || "—"}</span>
                    ) : (
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
                    )}
                    {r.ambiguous && <span className="badge ambiguous" style={{ marginLeft: 6 }}>needs review</span>}
                    {cancelReq && <span className="badge ambiguous" style={{ marginLeft: 6 }}>cancel requested</span>}
                    {isSuperseded && <span className="badge superseded" style={{ marginLeft: 6 }}>superseded</span>}
                  </td>
                  <td style={{ color: "#6b7280" }}>{r.rawMessage}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {!live && (
                      <button className="danger" onClick={() => removeRow(i)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {phase === "live" && rows.length === 0 && (
        <div className="empty">Tracking {capturedItem} — bids will appear here as members send tells.</div>
      )}
      {phase === "review" && rows.length === 0 && <div className="empty">No bids were captured for this round.</div>}
      {phase === "idle" && !error && !autoStarted && (
        <div className="empty">Name the item and click Capture Bids, or just announce "&lt;item&gt; send tells" in game.</div>
      )}
    </div>
  );
}
