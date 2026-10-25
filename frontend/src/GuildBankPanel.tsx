import { useEffect, useMemo, useState } from "react";
import {
  ClearAllBankDesignations,
  CreateBankMule,
  MarkAllContainersGuild,
  PreviewBankSync,
  RemoveBankUnverified,
  ResolveBankMove,
  ScanGuildBank,
  SubmitBankSync,
  ToggleBankContainer,
  ToggleBankItem,
  UpdateBankSlotFlags,
} from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";
import type {
  BankCharacterExport,
  BankContainer,
  BankContainerSeed,
  BankMoveWarning,
  BankSyncBlocked,
  BankUnverifiedItem,
  GuildBankState,
} from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/models";
import type { BankSyncDiff } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/internal/officerapi/models";
import { ConfirmDialog } from "./ConfirmDialog";

// The Guild Bank tab (PLAN.md §9/§11 Phase 8.4; per-item designation,
// bag-move detection, and the currency purge added 2026-09-25 after
// officer feedback). Every read comes from a fresh ScanGuildBank() call —
// no local caching between mutations, so a toggle saved here or a
// designation changed by another officer is never stale for more than one
// refresh. The one rule this whole tab exists to enforce: a
// container/item is never synced unless the officer explicitly flagged it
// guild — see BankContainer/BankItem's "guild" field and
// bankexport.BuildSyncRows on the Go side, which is the only thing that
// ever turns a flag into an upload row.

function timeAgo(iso: string): string {
  if (!iso) return "unknown";
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Mirrors internal/bankexport/moves.go's isSharedContainerName. A SharedBank
// slot is flagged on a character like any bag (2026-10-25: EQ account groups
// are gone); it only differs in being shared by every character on the
// login, so flag it on one of them.
function isSharedContainer(name: string): boolean {
  return name.startsWith("SharedBank");
}

function guildSlotCount(exp: BankCharacterExport): number {
  let count = 0;
  for (const c of [...(exp.bags ?? []), ...(exp.bank ?? []), ...(exp.sharedBank ?? [])]) {
    if (c.guild) {
      count += 1;
      continue;
    }
    count += (c.items ?? []).filter((it) => it.guild).length;
  }
  return count;
}

// containerSeed is what a container-level flag needs to seed its
// move-detection baseline: the bag's own identity, or (Loose) the one
// item sitting directly in the slot.
// findContainer resolves a FlagSuggestion's plain container name back to
// the real BankContainer object onToggleContainer needs (item identity for
// the seed, current guild state) — 2026-09-27.
function findContainer(exp: BankCharacterExport, name: string): BankContainer | undefined {
  return [...(exp.bags ?? []), ...(exp.bank ?? []), ...(exp.sharedBank ?? [])].find((c) => c.container === name);
}

// Every flagged SharedBank position on a character, as remove slots — what
// "Unflag Shared Bank here" sends when two characters on one login both
// have it flagged.
function sharedBankFlags(exp: BankCharacterExport): { container: string; slotIndex: number }[] {
  const out: { container: string; slotIndex: number }[] = [];
  for (const c of exp.sharedBank ?? []) {
    if (c.guild) {
      out.push({ container: c.container, slotIndex: 0 });
      continue;
    }
    for (const it of c.items ?? []) if (it.guild) out.push({ container: c.container, slotIndex: it.slotIndex });
  }
  return out;
}

function containerSeed(c: BankContainer): { itemId: number; itemName: string } {
  if (!c.loose) return { itemId: c.bagItemId, itemName: c.bagName };
  const first = (c.items ?? [])[0];
  return { itemId: first?.itemId ?? 0, itemName: first?.itemName ?? "" };
}

// BankSyncDiff's array fields come back "T[] | null" (a Go nil slice —
// see this repo's own established gotcha) even though the server never
// actually sends null for them; normalize once here rather than `?? []`
// at every call site.
type DiffRow = { container: string; slotIndex: number; itemName: string; quantity: number };
type Diff = {
  characterId: number;
  added: DiffRow[];
  removed: DiffRow[];
  changed: { before: DiffRow; after: DiffRow }[];
  unchanged: number;
  // 2026-09-27 unverified-item reconciliation — which of this holder's
  // sheet/manual rows this sync matched against a real synced item
  // (verified), and which it still couldn't find (notFound, needs an
  // officer's review on the site's own /bank page — nothing to act on
  // from here).
  verified: DiffRow[];
  notFound: DiffRow[];
};

function normalizeDiff(d: BankSyncDiff): Diff {
  return {
    characterId: d.characterId,
    added: d.added ?? [],
    removed: d.removed ?? [],
    changed: d.changed ?? [],
    unchanged: d.unchanged,
    verified: d.verified ?? [],
    notFound: d.notFound ?? [],
  };
}

function formatLoc(r: { container: string; slotIndex: number }): string {
  return r.slotIndex > 0 ? `${r.container}·${r.slotIndex}` : r.container;
}

// Groups diff rows by item name (2026-09-25 officer feedback: the old
// comma-joined item-name string was unreadable at a glance, especially on
// a first sync with hundreds of rows) — "Item ×count (qty) — loc1, loc2…".
function groupDiffRows(rows: DiffRow[]): { itemName: string; count: number; totalQty: number; locations: string[] }[] {
  const byName = new Map<string, { itemName: string; count: number; totalQty: number; locations: string[] }>();
  for (const r of rows) {
    const g = byName.get(r.itemName) ?? { itemName: r.itemName, count: 0, totalQty: 0, locations: [] };
    g.count += 1;
    g.totalQty += r.quantity;
    g.locations.push(formatLoc(r));
    byName.set(r.itemName, g);
  }
  return [...byName.values()].sort((a, b) => a.itemName.localeCompare(b.itemName));
}

export function GuildBankPanel() {
  const [state, setState] = useState<GuildBankState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [diffs, setDiffs] = useState<Diff[] | null>(null);
  const [blocked, setBlocked] = useState<BankSyncBlocked[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [diffFilter, setDiffFilter] = useState("");
  const [openCards, setOpenCards] = useState<Set<number>>(new Set());

  const [muleName, setMuleName] = useState("");
  const [creatingMule, setCreatingMule] = useState(false);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    ScanGuildBank()
      .then((s) => {
        setState(s);
        if (!selected && s.exports && s.exports.length > 0) setSelected(s.exports[0].character);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const exports = state?.exports ?? [];
  const unmatched = state?.unmatchedCharacters ?? [];

  const nameByCharacterId = useMemo(() => {
    const map = new Map<number, string>();
    for (const e of exports) if (e.rosterCharacterId !== null) map.set(e.rosterCharacterId, e.character);
    return map;
  }, [exports]);

  const lastImportByCharacterId = useMemo(() => {
    const map = new Map<number, boolean>();
    for (const e of exports) if (e.rosterCharacterId !== null) map.set(e.rosterCharacterId, e.lastImport !== null);
    return map;
  }, [exports]);

  const current = exports.find((e) => e.character === selected) ?? null;
  const totalWarnings = exports.reduce((sum, e) => sum + (e.moveWarnings ?? []).length, 0);
  const sharedConflicts = exports.filter((e) => (e.sharedBankAlsoFlaggedOn ?? []).length > 0);

  // Flagging something guild is the risky direction (unflagging just stops
  // it being uploaded next sync — always safe). Only a SharedBank
  // container is confirmed first — its contents are the same on every
  // character on that EQ login, so the officer is reminded to flag it on
  // just one of them. An ordinary personal container is NOT
  // confirmed (2026-09-26 officer feedback: confirming every single toggle
  // on a non-mule test character made routine bag-by-bag flagging
  // unusable) — same reasoning per-item toggles already used: one bag on
  // one character is a small, easily-reversible blast radius, same as one
  // item.
  type PendingConfirm =
    | { kind: "toggleContainer"; exp: BankCharacterExport; isShared: boolean; container: BankContainer }
    | { kind: "markAll"; exp: BankCharacterExport; scope: "bank" | "bags" }
    | { kind: "clearAllPersonal"; exp: BankCharacterExport };
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  async function performToggleContainer(exp: BankCharacterExport, container: BankContainer) {
    const key = `${exp.character}:${container.container}`;
    setSavingKey(key);
    setError(null);
    const nextGuild = !container.guild;
    const seed = containerSeed(container);
    try {
      await ToggleBankContainer(exp.rosterCharacterId!, container.container, nextGuild, seed.itemId, seed.itemName);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(null);
    }
  }

  function toggleContainer(exp: BankCharacterExport, isShared: boolean, container: BankContainer) {
    if (exp.rosterCharacterId === null) return;

    const turningOn = !container.guild;
    if (turningOn && isShared) {
      setPendingConfirm({ kind: "toggleContainer", exp, isShared, container });
      return;
    }
    void performToggleContainer(exp, container);
  }

  // Unlike toggleContainer, per-item toggles must sometimes reconcile the
  // whole-container flag rather than just touching their own position:
  //   - Unchecking an item while the whole bag is flagged ("guild") would
  //     otherwise do nothing visible — every item's checked state comes
  //     from `whole || sub[slot]`, and removing a sub-flag that was never
  //     set can't turn an item off while `whole` is still true. Instead,
  //     split: drop the whole-container flag and add an individual flag
  //     for every OTHER item, so they stay flagged and only this one
  //     comes off.
  //   - Checking the last individually-unflagged item makes every item in
  //     the bag flagged — collapse back to one whole-container flag
  //     instead of leaving N separate per-item rows around.
  // Both go through the one atomic UpdateBankSlotFlags call so the bag
  // never passes through an inconsistent intermediate state.
  async function toggleItem(exp: BankCharacterExport, _isShared: boolean, container: BankContainer, slotIndex: number, currentGuild: boolean, itemId: number, itemName: string) {
    if (exp.rosterCharacterId === null) return;
    const key = `${exp.character}:${container.container}:${slotIndex}`;
    setSavingKey(key);
    setError(null);
    const nextGuild = !currentGuild;
    const items = container.items ?? [];
    const characterId = exp.rosterCharacterId;
    try {
      if (!nextGuild && container.guild) {
        const add = items
          .filter((it) => it.slotIndex !== slotIndex)
          .map((it) => ({ container: container.container, slotIndex: it.slotIndex, expectedItemId: it.itemId, expectedItemName: it.itemName }));
        const remove = [{ container: container.container, slotIndex: 0 }];
        await UpdateBankSlotFlags(characterId, add, remove);
      } else if (nextGuild && !container.guild && items.length > 0 && items.every((it) => it.slotIndex === slotIndex || it.guild)) {
        const seed = containerSeed(container);
        const add = [{ container: container.container, slotIndex: 0, expectedItemId: seed.itemId, expectedItemName: seed.itemName }];
        const remove = items.map((it) => ({ container: container.container, slotIndex: it.slotIndex }));
        await UpdateBankSlotFlags(characterId, add, remove);
      } else {
        await ToggleBankItem(characterId, container.container, slotIndex, nextGuild, itemId, itemName);
      }
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(null);
    }
  }

  async function performMarkAll(exp: BankCharacterExport, scope: "bank" | "bags") {
    if (exp.rosterCharacterId === null) return;
    const containers = scope === "bank" ? (exp.bank ?? []) : (exp.bags ?? []);
    const seeds: BankContainerSeed[] = containers.map((c) => {
      const s = containerSeed(c);
      return { container: c.container, expectedItemId: s.itemId, expectedItemName: s.itemName };
    });
    setSavingKey(`${exp.character}:__bulk`);
    setError(null);
    try {
      await MarkAllContainersGuild(exp.rosterCharacterId, seeds);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(null);
    }
  }

  function markAll(exp: BankCharacterExport, scope: "bank" | "bags") {
    if (exp.rosterCharacterId === null) return;
    // Always confirm — bulk-flagging every slot of a kind at once is the
    // single highest-blast-radius action in this tab.
    setPendingConfirm({ kind: "markAll", exp, scope });
  }

  async function confirmPendingAction() {
    if (!pendingConfirm) return;
    setConfirmBusy(true);
    try {
      if (pendingConfirm.kind === "toggleContainer") {
        await performToggleContainer(pendingConfirm.exp, pendingConfirm.container);
      } else if (pendingConfirm.kind === "markAll") {
        await performMarkAll(pendingConfirm.exp, pendingConfirm.scope);
      } else {
        await performClearAllPersonal(pendingConfirm.exp);
      }
    } finally {
      setConfirmBusy(false);
      setPendingConfirm(null);
    }
  }

  async function performClearAllPersonal(exp: BankCharacterExport) {
    if (exp.rosterCharacterId === null) return;
    setSavingKey(`${exp.character}:__bulk`);
    setError(null);
    try {
      await ClearAllBankDesignations(exp.rosterCharacterId);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(null);
    }
  }

  // Clears only this character's SharedBank flags — the fix for two
  // characters on one EQ login both set to upload its Shared Bank.
  async function clearSharedBank(exp: BankCharacterExport) {
    if (exp.rosterCharacterId === null) return;
    setSavingKey(`${exp.character}:__bulk`);
    setError(null);
    try {
      await UpdateBankSlotFlags(exp.rosterCharacterId, [], sharedBankFlags(exp));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(null);
    }
  }

  function clearAllPersonal(exp: BankCharacterExport) {
    if (exp.rosterCharacterId === null) return;
    // Always confirm — same bulk-blast-radius reasoning as markAll, just
    // in the opposite (unflagging) direction: a mis-click here silently
    // drops every Bags/Bank/Shared Bank designation this character has,
    // with no undo besides re-flagging each one by hand.
    setPendingConfirm({ kind: "clearAllPersonal", exp });
  }

  // Resolving a warning: "move" the flag to the suggested/picked position,
  // "keep" it where it is (accepting the current occupant as correct), or
  // "unflag" it entirely. All three go through ResolveBankMove — see
  // app.go's own doc comment on that method for why it's always a single
  // remove-then-add designations call.
  async function resolveWarning(exp: BankCharacterExport, w: BankMoveWarning, action: "move" | "keep" | "unflag", target?: { container: string; slotIndex: number }) {
    if (exp.rosterCharacterId === null) return;
    const key = `${exp.character}:${w.container}:${w.slotIndex}:resolve`;
    setResolvingKey(key);
    setError(null);
    try {
      await ResolveBankMove({
        characterId: exp.rosterCharacterId,
        container: w.container,
        slotIndex: w.slotIndex,
        action,
        targetContainer: target?.container ?? w.suggestedContainer,
        targetSlotIndex: target?.slotIndex ?? w.suggestedSlotIndex,
        // Expected is the identity being CHASED ("Deluxe Toolbox") — what
        // a "move" should seed the new position with. Found is whatever's
        // sitting at the OLD, abandoned position right now — what "keep"
        // uses instead. Passing Found for "move" was a real bug caught by
        // clicking through this exact flow (2026-09-25): it seeded the
        // new slot's baseline with the wrong item entirely.
        expectedItemId: w.expectedItemId,
        expectedItemName: w.expectedItemName,
        foundItemId: w.foundItemId,
        foundItemName: w.foundItemName,
      });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolvingKey(null);
    }
  }

  // "Flag all suggested bags" — the same ToggleBankContainer call as the
  // per-suggestion button, once per personal bag. SharedBank suggestions
  // are left to their own button (they're confirmed individually — flag
  // a login's Shared Bank on one character only).
  async function flagAllSuggested(exp: BankCharacterExport) {
    if (exp.rosterCharacterId === null) return;
    const targets = (exp.flagSuggestions ?? [])
      .map((s) => findContainer(exp, s.container))
      .filter((c): c is BankContainer => !!c && !c.guild && !isSharedContainer(c.container));
    if (targets.length === 0) return;
    setSavingKey(`${exp.character}:__bulk`);
    setError(null);
    try {
      for (const c of targets) {
        const seed = containerSeed(c);
        await ToggleBankContainer(exp.rosterCharacterId, c.container, true, seed.itemId, seed.itemName);
      }
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      load();
    } finally {
      setSavingKey(null);
    }
  }

  async function removeReviewed(ids: number[], note: string): Promise<string | null> {
    try {
      await RemoveBankUnverified(ids, note);
      load();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async function openPreview() {
    setPreviewOpen(true);
    setPreviewLoading(true);
    setDiffs(null);
    setBlocked([]);
    setSyncMessage(null);
    setDiffFilter("");
    setOpenCards(new Set());
    setError(null);
    try {
      const result = await PreviewBankSync();
      const normalized = (result?.diffs ?? []).map(normalizeDiff);
      setDiffs(normalized);
      setBlocked(result?.blocked ?? []);
      // A first-ever sync for a character (no prior lastImport) starts
      // collapsed to just its summary counts — hundreds of "added" rows on
      // day one is exactly the unreadable case officer feedback called out.
      setOpenCards(new Set(normalized.filter((d) => lastImportByCharacterId.get(d.characterId)).map((d) => d.characterId)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPreviewOpen(false);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function confirmSync() {
    setSyncing(true);
    setError(null);
    try {
      const result = await SubmitBankSync();
      const normalized = (result?.diffs ?? []).map(normalizeDiff);
      const totalRows = normalized.reduce((sum, d) => sum + d.added.length + d.removed.length + d.changed.length + d.unchanged, 0);
      const blockedCount = result?.blocked?.length ?? 0;
      const notFoundCount = normalized.reduce((sum, d) => sum + d.notFound.length, 0);
      setSyncMessage(
        `Synced ${normalized.length} character${normalized.length === 1 ? "" : "s"}, ${totalRows} row(s) total.` +
          (blockedCount > 0 ? ` ${blockedCount} character${blockedCount === 1 ? "" : "s"} skipped — resolve their warnings and sync again.` : "") +
          (notFoundCount > 0 ? ` ${notFoundCount} old sheet item${notFoundCount === 1 ? "" : "s"} weren't found — see "Needs review" on each character.` : ""),
      );
      setPreviewOpen(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  function toggleCard(characterId: number) {
    setOpenCards((prev) => {
      const next = new Set(prev);
      if (next.has(characterId)) next.delete(characterId);
      else next.add(characterId);
      return next;
    });
  }

  async function createMule() {
    const name = muleName.trim();
    if (!name) return;
    setCreatingMule(true);
    setError(null);
    try {
      await CreateBankMule(name);
      setMuleName("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingMule(false);
    }
  }

  return (
    <div>
      <div className="panel-header">
        <h2>Guild Bank</h2>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          {loading && <span style={{ color: "#6b7280", fontSize: 13 }}>Scanning…</span>}
          <button className="secondary" onClick={load} disabled={loading}>
            Refresh
          </button>
          <button className="primary" onClick={openPreview} disabled={loading || exports.length === 0}>
            Preview sync
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {syncMessage && <div className="success">{syncMessage}</div>}

      {sharedConflicts.length > 0 && (
        <div className="warning">
          The Shared Bank is flagged on more than one character on the same EQ login (
          {sharedConflicts.map((e) => e.character).join(", ")}). Every character on a login sees the same Shared Bank, so it would be
          counted twice. Those characters are skipped by Preview/Submit sync until you unflag the Shared Bank on all but one.
        </div>
      )}

      {totalWarnings > 0 && (
        <div className="warning">
          {totalWarnings} bag/item warning{totalWarnings === 1 ? "" : "s"} across your characters — a flagged bag or item doesn&apos;t
          match what was expected there (it may have moved). Those characters are skipped by Preview/Submit sync until resolved; open a
          character to see and resolve its warnings.
        </div>
      )}

      {!loading && state && exports.length === 0 && unmatched.length === 0 && (
        <div className="empty">
          No inventory exports found under {state.gameDir || "your EverQuest folder"}. Run <code>/outputfile inventory</code> in-game on each
          mule, then Refresh.
        </div>
      )}

      <div className="bank-layout">
        <div className="bank-sidebar">
          <div className="bank-sidebar-section">
            <div className="bank-sidebar-title">Characters</div>
            {exports.map((exp) => {
              const slots = guildSlotCount(exp);
              const warnCount = (exp.moveWarnings ?? []).length;
              const reviewCount = (exp.needsReview ?? []).length + (exp.flagSuggestions ?? []).length;
              return (
                <button
                  key={exp.character}
                  className={`bank-char-row ${selected === exp.character ? "bank-char-row-active" : ""}`}
                  onClick={() => setSelected(exp.character)}
                >
                  <div className="bank-char-row-name">
                    {exp.character}
                    <span className="badge superseded" style={{ marginLeft: 6 }}>
                      {exp.rosterCharType || "?"}
                    </span>
                    {warnCount > 0 && (
                      <span className="badge ambiguous" style={{ marginLeft: 6 }}>
                        ⚠ {warnCount}
                      </span>
                    )}
                    {(exp.sharedBankAlsoFlaggedOn ?? []).length > 0 && (
                      <span className="badge ambiguous" style={{ marginLeft: 6 }} title="Shared Bank also flagged on another character on this login">
                        ⚠ Shared Bank
                      </span>
                    )}
                    {reviewCount > 0 && (
                      <span className="badge ambiguous" style={{ marginLeft: 6 }} title="Old sheet items to review: bags to flag, or items a sync couldn't find">
                        {reviewCount} to review
                      </span>
                    )}
                  </div>
                  <div className="bank-char-row-meta">
                    {slots} guild slot{slots === 1 ? "" : "s"} · exported {timeAgo(exp.exportedAt)}
                  </div>
                </button>
              );
            })}
          </div>

          {unmatched.length > 0 && (
            <div className="bank-sidebar-section">
              <div className="bank-sidebar-title">Not on the roster</div>
              {unmatched.map((name) => (
                <div key={name} className="bank-char-row bank-char-row-unmatched">
                  <div className="bank-char-row-name">{name}</div>
                </div>
              ))}
              <div className="bank-account-card-header" style={{ marginTop: 6 }}>
                <input
                  type="text"
                  placeholder="Mule name…"
                  value={muleName}
                  onChange={(e) => setMuleName(e.target.value)}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button className="secondary" onClick={createMule} disabled={creatingMule || !muleName.trim()}>
                  {creatingMule ? "Creating…" : "Create mule"}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="bank-detail">
          {!current && <div className="empty">Select a character to see their inventory.</div>}
          {current && (
            <CharacterDetail
              exp={current}
              hideEmpty={hideEmpty}
              setHideEmpty={setHideEmpty}
              savingKey={savingKey}
              resolvingKey={resolvingKey}
              onToggleContainer={toggleContainer}
              onToggleItem={toggleItem}
              onMarkAll={markAll}
              onClearAll={clearAllPersonal}
              onClearSharedBank={clearSharedBank}
              onResolveWarning={resolveWarning}
              onFlagAllSuggested={flagAllSuggested}
              onRemoveReviewed={removeReviewed}
            />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={previewOpen}
        title="Sync to guild bank"
        confirmLabel={syncing ? "Syncing…" : "Sync to guild bank"}
        busy={syncing || previewLoading}
        onCancel={() => !syncing && setPreviewOpen(false)}
        onConfirm={confirmSync}
        body={
          previewLoading ? (
            <span>Building preview…</span>
          ) : (
            <PreviewBody
              diffs={diffs}
              blocked={blocked}
              nameByCharacterId={nameByCharacterId}
              filter={diffFilter}
              setFilter={setDiffFilter}
              openCards={openCards}
              toggleCard={toggleCard}
            />
          )
        }
      />

      <ConfirmDialog
        open={pendingConfirm !== null}
        title={pendingConfirm?.kind === "clearAllPersonal" ? "Clear all guild flags?" : "Flag as guild property?"}
        confirmLabel={confirmBusy ? "Saving…" : pendingConfirm?.kind === "clearAllPersonal" ? "Clear all" : "Flag it"}
        busy={confirmBusy}
        onCancel={() => !confirmBusy && setPendingConfirm(null)}
        onConfirm={confirmPendingAction}
        body={pendingConfirm && pendingConfirmBody(pendingConfirm)}
      />
    </div>
  );
}

function PreviewBody({
  diffs,
  blocked,
  nameByCharacterId,
  filter,
  setFilter,
  openCards,
  toggleCard,
}: {
  diffs: Diff[] | null;
  blocked: BankSyncBlocked[];
  nameByCharacterId: Map<number, string>;
  filter: string;
  setFilter: (v: string) => void;
  openCards: Set<number>;
  toggleCard: (id: number) => void;
}) {
  if (!diffs) return <span>Nothing to sync — no character has any guild-flagged inventory yet.</span>;

  const totalRows = diffs.reduce((sum, d) => sum + d.added.length + d.removed.length + d.changed.length, 0);
  const showFilter = totalRows > 40;
  const q = filter.trim().toLowerCase();

  return (
    <div>
      {blocked.length > 0 && (
        <div className="warning" style={{ marginBottom: 10 }}>
          <strong>Skipped until resolved:</strong>{" "}
          {blocked
            .map((b) => {
              const reasons: string[] = [];
              if (b.warnings > 0) reasons.push(`${b.warnings} bag warning${b.warnings === 1 ? "" : "s"}`);
              const others = b.sharedBankAlsoFlaggedOn ?? [];
              if (others.length > 0) reasons.push(`Shared Bank also flagged on ${others.join(", ")}`);
              return `${b.character} (${reasons.join("; ")})`;
            })
            .join(", ")}
        </div>
      )}
      {diffs.length === 0 && blocked.length === 0 && <span>Nothing to sync — no character has any guild-flagged inventory yet.</span>}
      {showFilter && (
        <input
          type="text"
          placeholder="Filter items…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ marginBottom: 8, width: "100%" }}
        />
      )}
      <div style={{ maxHeight: 400, overflowY: "auto" }}>
        {diffs.map((d) => {
          const name = nameByCharacterId.get(d.characterId) ?? `#${d.characterId}`;
          const open = openCards.has(d.characterId);
          const added = q ? d.added.filter((r) => r.itemName.toLowerCase().includes(q)) : d.added;
          const removed = q ? d.removed.filter((r) => r.itemName.toLowerCase().includes(q)) : d.removed;
          const changed = q
            ? d.changed.filter((c) => c.before.itemName.toLowerCase().includes(q) || c.after.itemName.toLowerCase().includes(q))
            : d.changed;
          const verified = q ? d.verified.filter((r) => r.itemName.toLowerCase().includes(q)) : d.verified;
          const notFound = q ? d.notFound.filter((r) => r.itemName.toLowerCase().includes(q)) : d.notFound;
          const bigRemoval = d.removed.length > 0 && d.unchanged + d.removed.length > 0 && d.removed.length / (d.unchanged + d.removed.length) > 0.25;

          return (
            <div key={d.characterId} style={{ marginBottom: 10, borderBottom: "1px solid #262626", paddingBottom: 8 }}>
              <button
                type="button"
                onClick={() => toggleCard(d.characterId)}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit", textAlign: "left" }}
              >
                {open ? "▾" : "▸"} <strong>{name}</strong>{" "}
                <span style={{ color: "#9ca3af" }}>
                  (+{d.added.length} −{d.removed.length} ~{d.changed.length}, {d.unchanged} unchanged)
                </span>
                {d.verified.length > 0 && (
                  <span style={{ marginLeft: 6, color: "#38bdf8" }}>· {d.verified.length} verified from sheet</span>
                )}
                {d.notFound.length > 0 && (
                  <span className="badge ambiguous" style={{ marginLeft: 6 }}>
                    {d.notFound.length} not found
                  </span>
                )}
                {bigRemoval && (
                  <span className="badge ambiguous" style={{ marginLeft: 6 }}>
                    large removal
                  </span>
                )}
              </button>
              {open && (
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  {added.length > 0 && (
                    <div style={{ color: "#10b981" }}>
                      {groupDiffRows(added).map((g) => (
                        <div key={g.itemName}>
                          + {g.itemName} {g.count > 1 ? `×${g.count} (${g.totalQty})` : g.totalQty > 1 ? `(${g.totalQty})` : ""} — {g.locations.join(", ")}
                        </div>
                      ))}
                    </div>
                  )}
                  {removed.length > 0 && (
                    <div style={{ color: "#f87171" }}>
                      {groupDiffRows(removed).map((g) => (
                        <div key={g.itemName}>
                          − {g.itemName} {g.count > 1 ? `×${g.count} (${g.totalQty})` : g.totalQty > 1 ? `(${g.totalQty})` : ""} — {g.locations.join(", ")}
                        </div>
                      ))}
                    </div>
                  )}
                  {changed.length > 0 && (
                    <div style={{ color: "#fbbf24" }}>
                      {changed.map((c, i) => (
                        <div key={i}>
                          ~ {c.before.itemName} → {c.after.itemName} ({c.after.quantity}) @ {formatLoc(c.after)}
                        </div>
                      ))}
                    </div>
                  )}
                  {verified.length > 0 && (
                    <div style={{ color: "#38bdf8" }}>
                      {groupDiffRows(verified).map((g) => (
                        <div key={g.itemName}>
                          ✓ {g.itemName} {g.count > 1 ? `×${g.count} (${g.totalQty})` : g.totalQty > 1 ? `(${g.totalQty})` : ""} — confirmed at {g.locations.join(", ")}
                        </div>
                      ))}
                    </div>
                  )}
                  {notFound.length > 0 && (
                    <div style={{ color: "#fb923c" }}>
                      {groupDiffRows(notFound).map((g) => (
                        <div key={g.itemName}>
                          ? {g.itemName} — sheet says {g.totalQty}, not found in this sync (review on the site&apos;s /bank page)
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function pendingConfirmBody(pending: {
  kind: "toggleContainer" | "markAll" | "clearAllPersonal";
  exp: BankCharacterExport;
  isShared?: boolean;
  container?: BankContainer;
  scope?: "bank" | "bags";
}) {
  const { exp } = pending;
  if (pending.kind === "clearAllPersonal") {
    const total = guildSlotCount(exp);
    return (
      <span>
        Clear all {total} guild flag{total === 1 ? "" : "s"} (Bags, Bank and Shared Bank) on <strong>{exp.character}</strong>? This
        unflags every whole-bag and per-item guild designation on this character. There&apos;s no undo besides re-flagging each one
        by hand.
      </span>
    );
  }
  if (pending.kind === "toggleContainer") {
    return (
      <span>
        Flag <strong>{pending.container!.container}</strong> as guild property? This is the <strong>Shared Bank</strong>, which every
        character on {exp.character}&apos;s EQ login shares. Flag it on <strong>one</strong> of those characters only, or its items
        will be counted twice.
      </span>
    );
  }
  const scope = pending.scope === "bags" ? "Bags" : "Bank";
  const count = (pending.scope === "bags" ? exp.bags : exp.bank)?.length ?? 0;
  return (
    <span>
      Flag all {count} {scope} slot{count === 1 ? "" : "s"} on <strong>{exp.character}</strong> as guild property?
      {exp.rosterCharType !== "mule" && (
        <>
          {" "}
          {exp.character} isn&apos;t marked as a mule ({exp.rosterCharType}) — this will include <strong>any personal items</strong>{" "}
          currently sitting in their {scope.toLowerCase()} too.
        </>
      )}
    </span>
  );
}

function WarningCard({
  exp,
  warning,
  resolving,
  onResolve,
}: {
  exp: BankCharacterExport;
  warning: BankMoveWarning;
  resolving: boolean;
  onResolve: (exp: BankCharacterExport, w: BankMoveWarning, action: "move" | "keep" | "unflag", target?: { container: string; slotIndex: number }) => void;
}) {
  const position = warning.slotIndex > 0 ? `${warning.container} slot ${warning.slotIndex}` : warning.container;
  const expected = warning.expectedItemName || "(unknown)";
  const found = warning.foundItemName || "(nothing — this slot is empty)";
  const candidates = warning.candidates ?? [];

  return (
    <div className="bank-container-card" style={{ borderColor: "#a16207", marginBottom: 8 }}>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <strong>{position}</strong> was flagged guild, expecting <strong>{expected}</strong>, but now has <strong>{found}</strong>.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        {warning.hasSuggestion ? (
          <button className="secondary" disabled={resolving} onClick={() => onResolve(exp, warning, "move")}>
            Move flag to {warning.suggestedContainer}
            {warning.suggestedSlotIndex > 0 ? ` slot ${warning.suggestedSlotIndex}` : ""}
          </button>
        ) : (
          candidates.length > 1 &&
          candidates.map((c) => (
            <button
              key={`${c.container}:${c.slotIndex}`}
              className="secondary"
              disabled={resolving}
              onClick={() => onResolve(exp, warning, "move", { container: c.container, slotIndex: c.slotIndex })}
            >
              Move flag to {c.container}
              {c.slotIndex > 0 ? ` slot ${c.slotIndex}` : ""}
            </button>
          ))
        )}
        <button className="secondary" disabled={resolving} onClick={() => onResolve(exp, warning, "keep")}>
          Keep flag here
        </button>
        <button className="danger" disabled={resolving} onClick={() => onResolve(exp, warning, "unflag")}>
          Unflag
        </button>
        {resolving && <span style={{ color: "#6b7280", fontSize: 12 }}>Saving…</span>}
      </div>
    </div>
  );
}

function ContainerCard({
  exp,
  container,
  isShared,
  hideEmpty,
  disabled,
  savingKey,
  onToggleContainer,
  onToggleItem,
}: {
  exp: BankCharacterExport;
  container: BankContainer;
  isShared: boolean;
  hideEmpty: boolean;
  disabled: boolean;
  savingKey: string | null;
  onToggleContainer: () => void;
  onToggleItem: (slotIndex: number, currentGuild: boolean, itemId: number, itemName: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const items = container.items ?? [];
  const anyItemGuild = container.guild || items.some((it) => it.guild);
  const emptyButFlagged = container.guild && items.length === 0;
  // A guild-flagged slot that's come up empty is exactly the signal worth
  // seeing (the bag may have been moved elsewhere) — never let "Hide empty
  // bags" swallow it. The full warning card (with move/keep/unflag
  // actions) lives at the top of the tab; this badge is just a quick
  // in-place pointer back to it.
  if (hideEmpty && items.length === 0 && !emptyButFlagged) return null;

  const label = container.loose
    ? container.container
    : container.bagName
      ? `${container.container} · ${container.bagName}`
      : container.container;

  const containerKey = `${exp.character}:${container.container}`;
  const containerSaving = savingKey === containerKey;

  return (
    <div className={`bank-container-card ${anyItemGuild ? "bank-container-card-guild" : ""}`}>
      <div className="bank-container-card-header">
        <button type="button" className="bank-container-toggle-open" onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} {label}
          {!container.loose && container.capacity > 0 && (
            <span style={{ color: "#6b7280", marginLeft: 6 }}>
              {items.length}/{container.capacity}
            </span>
          )}
          {emptyButFlagged && (
            <span className="badge ambiguous" style={{ marginLeft: 6 }}>
              empty — see warning above
            </span>
          )}
        </button>
        <label className="bank-guild-switch" title={isShared ? "Shared by every character on this EQ login — flag it on one of them only" : undefined}>
          <input type="checkbox" checked={container.guild} disabled={disabled || containerSaving} onChange={onToggleContainer} />
          {containerSaving ? "…" : "Guild"}
        </label>
      </div>
      {open && (
        <div className="bank-item-list">
          {items.length === 0 && <div className="bank-item-empty">(empty)</div>}
          {items.map((item) => {
            const itemKey = `${containerKey}:${item.slotIndex}`;
            const itemSaving = savingKey === itemKey;
            return (
              <div key={item.slotIndex} className="bank-item">
                <label style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
                  <input
                    type="checkbox"
                    checked={item.guild}
                    disabled={disabled || itemSaving}
                    title={container.guild ? "Covered by the whole-bag flag — unchecking splits it into per-item flags" : undefined}
                    onChange={() => onToggleItem(item.slotIndex, item.guild, item.itemId, item.itemName)}
                  />
                  <span>{item.itemName}</span>
                </label>
                {item.quantity > 1 && <span className="bank-item-qty">×{item.quantity}</span>}
                {itemSaving && <span style={{ color: "#6b7280", fontSize: 11 }}>…</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CharacterDetail({
  exp,
  hideEmpty,
  setHideEmpty,
  savingKey,
  resolvingKey,
  onToggleContainer,
  onToggleItem,
  onMarkAll,
  onClearAll,
  onResolveWarning,
  onFlagAllSuggested,
  onRemoveReviewed,
  onClearSharedBank,
}: {
  exp: BankCharacterExport;
  hideEmpty: boolean;
  setHideEmpty: (v: boolean) => void;
  savingKey: string | null;
  resolvingKey: string | null;
  onToggleContainer: (exp: BankCharacterExport, isShared: boolean, container: BankContainer) => void;
  onToggleItem: (exp: BankCharacterExport, isShared: boolean, container: BankContainer, slotIndex: number, currentGuild: boolean, itemId: number, itemName: string) => void;
  onMarkAll: (exp: BankCharacterExport, scope: "bank" | "bags") => void;
  onClearAll: (exp: BankCharacterExport) => void;
  onResolveWarning: (exp: BankCharacterExport, w: BankMoveWarning, action: "move" | "keep" | "unflag", target?: { container: string; slotIndex: number }) => void;
  onFlagAllSuggested: (exp: BankCharacterExport) => void;
  onRemoveReviewed: (ids: number[], note: string) => Promise<string | null>;
  onClearSharedBank: (exp: BankCharacterExport) => void;
}) {
  const bulkSaving = savingKey === `${exp.character}:__bulk`;
  const warnings = exp.moveWarnings ?? [];
  const flagSuggestions = exp.flagSuggestions ?? [];
  const sharedAlsoOn = exp.sharedBankAlsoFlaggedOn ?? [];

  return (
    <div>
      <div className="bank-detail-header">
        <div>
          <h3 style={{ margin: 0 }}>{exp.character}</h3>
          <div style={{ color: "#6b7280", fontSize: 12 }}>
            {exp.sourceFile} · exported {timeAgo(exp.exportedAt)}
            {exp.lastImport && <span> · last synced {timeAgo(exp.lastImport.createdAt)} by {exp.lastImport.uploadedByName}</span>}
          </div>
        </div>
        <label className="bank-modal-check" style={{ fontSize: 12 }}>
          <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />
          Hide empty bags
        </label>
      </div>

      {sharedAlsoOn.length > 0 && (
        <div className="bank-container-card" style={{ borderColor: "#a16207", marginBottom: 12 }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            This character&apos;s <strong>Shared Bank</strong> is also flagged on <strong>{sharedAlsoOn.join(", ")}</strong>. They share an
            EQ login, so it would be synced twice. Keep the flags on one character and unflag the rest. Until then these characters are
            skipped by sync.
          </div>
          <button className="secondary" disabled={bulkSaving} onClick={() => onClearSharedBank(exp)}>
            Unflag Shared Bank on {exp.character}
          </button>
        </div>
      )}

      {warnings.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {warnings.map((w) => (
            <WarningCard
              key={`${w.container}:${w.slotIndex}`}
              exp={exp}
              warning={w}
              resolving={resolvingKey === `${exp.character}:${w.container}:${w.slotIndex}:resolve`}
              onResolve={onResolveWarning}
            />
          ))}
        </div>
      )}

      {/* 2026-09-27 unverified-item tracking: the old sheet's numbers for
          this character are still sitting on unflagged bags — surfaced
          BEFORE a sync so fewer items end up needing officer review on
          the site's /bank page afterward. Purely advisory; flagging a
          suggestion is the exact same click as the ordinary checkbox. */}
      {flagSuggestions.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {flagSuggestions.filter((s) => !isSharedContainer(s.container)).length > 1 && (
            <button type="button" className="secondary" style={{ fontSize: 12, marginBottom: 6 }} onClick={() => onFlagAllSuggested(exp)} disabled={bulkSaving}>
              Flag all {flagSuggestions.filter((s) => !isSharedContainer(s.container)).length} suggested bags
            </button>
          )}
          {flagSuggestions.map((s) => {
            const container = findContainer(exp, s.container);
            if (!container) return null;
            const isShared = isSharedContainer(s.container);
            const names = [...new Set((s.matches ?? []).map((m) => m.itemName))];
            return (
              <div key={s.container} className="warning" style={{ marginBottom: 6 }}>
                Sheet says <strong>{s.container}</strong> holds guild item{names.length === 1 ? "" : "s"}: {names.join(", ")}. Not flagged yet.
                <button
                  type="button"
                  className="secondary"
                  style={{ marginLeft: 8, fontSize: 12 }}
                  onClick={() => onToggleContainer(exp, isShared, container)}
                >
                  Flag {s.container}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {(exp.needsReview ?? []).length > 0 && <NeedsReviewPanel key={exp.character} items={exp.needsReview ?? []} onRemove={onRemoveReviewed} />}

      <div className="toolbar">
        <button className="secondary" style={{ fontSize: 12 }} onClick={() => onMarkAll(exp, "bank")} disabled={bulkSaving}>
          Mark all Bank slots guild
        </button>
        <button className="secondary" style={{ fontSize: 12 }} onClick={() => onMarkAll(exp, "bags")} disabled={bulkSaving}>
          Mark all Bags guild
        </button>
        <button className="secondary" style={{ fontSize: 12 }} onClick={() => onClearAll(exp)} disabled={bulkSaving}>
          Clear all guild flags
        </button>
        {bulkSaving && <span style={{ color: "#6b7280", fontSize: 12 }}>Saving…</span>}
      </div>

      {(exp.equipped ?? []).length > 0 && (
        <details className="bank-section">
          <summary>Equipped ({(exp.equipped ?? []).length})</summary>
          <div className="bank-item-list">
            {(exp.equipped ?? []).map((it, idx) => (
              <div key={idx} className="bank-item">
                <span style={{ color: "#6b7280" }}>{it.location}:</span> {it.itemName}
              </div>
            ))}
          </div>
        </details>
      )}

      <details className="bank-section" open>
        <summary>Bags ({(exp.bags ?? []).length})</summary>
        <div className="bank-container-grid">
          {(exp.bags ?? []).map((c) => (
            <ContainerCard
              key={c.container}
              exp={exp}
              container={c}
              isShared={false}
              hideEmpty={hideEmpty}
              disabled={false}
              savingKey={savingKey}
              onToggleContainer={() => onToggleContainer(exp, false, c)}
              onToggleItem={(slotIndex, currentGuild, itemId, itemName) => onToggleItem(exp, false, c, slotIndex, currentGuild, itemId, itemName)}
            />
          ))}
        </div>
      </details>

      <details className="bank-section" open>
        <summary>Bank ({(exp.bank ?? []).length})</summary>
        <div className="bank-container-grid">
          {(exp.bank ?? []).map((c) => (
            <ContainerCard
              key={c.container}
              exp={exp}
              container={c}
              isShared={false}
              hideEmpty={hideEmpty}
              disabled={false}
              savingKey={savingKey}
              onToggleContainer={() => onToggleContainer(exp, false, c)}
              onToggleItem={(slotIndex, currentGuild, itemId, itemName) => onToggleItem(exp, false, c, slotIndex, currentGuild, itemId, itemName)}
            />
          ))}
        </div>
      </details>

      {(exp.sharedBank ?? []).length > 0 && (
        <details className="bank-section" open>
          <summary>
            Shared Bank ({(exp.sharedBank ?? []).length})
            <span style={{ color: "#6b7280", fontWeight: 400, fontSize: 12 }}> — shared by every character on this EQ login; flag it on one of them only</span>
          </summary>
          <div className="bank-container-grid">
            {(exp.sharedBank ?? []).map((c) => (
              <ContainerCard
                key={c.container}
                exp={exp}
                container={c}
                isShared={true}
                hideEmpty={hideEmpty}
                disabled={false}
                savingKey={savingKey}
                onToggleContainer={() => onToggleContainer(exp, true, c)}
                onToggleItem={(slotIndex, currentGuild, itemId, itemName) => onToggleItem(exp, true, c, slotIndex, currentGuild, itemId, itemName)}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// "Needs review" (2026-10-17): old sheet items a real sync of this
// character looked for, in a bag that WAS synced, and didn't find. Shown
// here so a banker deals with them while syncing instead of later on the
// website's /bank page. Two ways out: the item is in another bag (flag it,
// sync again — it's matched automatically), or it's really gone (select,
// say why, remove — audited on the site exactly like /bank's Remove).
function NeedsReviewPanel({ items, onRemove }: { items: BankUnverifiedItem[]; onRemove: (ids: number[], note: string) => Promise<string | null> }) {
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const removable = items.filter((i) => i.id > 0);
  const allChecked = removable.length > 0 && removable.every((i) => checked.has(i.id));

  function toggle(id: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function confirm() {
    setBusy(true);
    const error = await onRemove([...checked], note.trim());
    setBusy(false);
    setConfirming(false);
    if (error) setErr(error);
    else {
      setChecked(new Set());
      setNote("");
      setErr(null);
    }
  }

  return (
    <details className="bank-section" open style={{ marginBottom: 12 }}>
      <summary>
        Needs review ({items.length}) — old sheet items the last sync couldn&apos;t find
      </summary>
      <div style={{ padding: "8px 4px", fontSize: 12, color: "#9ca3af" }}>
        The sheet listed these in a bag that was synced, but they weren&apos;t there. If one is in another bag, flag that bag and sync
        again; it&apos;s matched automatically. If it&apos;s really gone, select it and remove it with a note.
      </div>
      {removable.length === 0 ? (
        <div style={{ fontSize: 12, color: "#9ca3af", padding: "0 4px 8px" }}>Update the site to remove these from here; for now use the website&apos;s Bank page.</div>
      ) : (
        <>
          <label className="bank-modal-check" style={{ fontSize: 12, padding: "0 4px" }}>
            <input type="checkbox" checked={allChecked} onChange={() => setChecked(allChecked ? new Set() : new Set(removable.map((i) => i.id)))} />
            Select all
          </label>
          <div className="bank-item-list">
            {items.map((it, idx) => (
              <label key={it.id || idx} className="bank-item bank-modal-check" style={{ fontSize: 12 }}>
                <input type="checkbox" checked={checked.has(it.id)} disabled={it.id <= 0} onChange={() => toggle(it.id)} />
                {it.itemName}
                {it.quantity > 1 ? ` ×${it.quantity}` : ""}
                <span style={{ color: "#6b7280", marginLeft: 6 }}>sheet: {it.legacyLocation || (it.kind === "manual" ? "added by hand" : "no location")}</span>
              </label>
            ))}
          </div>
          <div className="toolbar" style={{ marginTop: 6 }}>
            <input
              type="text"
              placeholder="Why are these gone? (e.g. handed out, sold, never existed)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
            />
            <button className="secondary" style={{ fontSize: 12 }} disabled={checked.size === 0 || !note.trim() || busy} onClick={() => setConfirming(true)}>
              Remove {checked.size || ""} selected
            </button>
          </div>
          {err && <div className="error" style={{ fontSize: 12 }}>{err}</div>}
        </>
      )}
      <ConfirmDialog
        open={confirming}
        title="Remove from the guild bank"
        confirmLabel={busy ? "Removing…" : `Remove ${checked.size}`}
        busy={busy}
        onCancel={() => !busy && setConfirming(false)}
        onConfirm={confirm}
        body={
          <span>
            Remove {checked.size} old sheet item{checked.size === 1 ? "" : "s"} from the guild bank? Each is recorded in the bank&apos;s audit log
            with your note: &ldquo;{note.trim()}&rdquo;.
          </span>
        }
      />
    </details>
  );
}
