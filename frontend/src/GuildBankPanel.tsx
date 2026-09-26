import { useEffect, useMemo, useState } from "react";
import {
  ClearAllBankDesignations,
  CreateBankMule,
  DeleteBankEqAccount,
  MarkAllContainersGuild,
  PreviewBankSync,
  ResolveBankMove,
  SaveBankEqAccount,
  ScanGuildBank,
  SubmitBankSync,
  ToggleBankContainer,
  ToggleBankItem,
} from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";
import type {
  BankCharacterExport,
  BankContainer,
  BankContainerSeed,
  BankMoveWarning,
  BankSyncBlocked,
  GuildBankState,
} from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/models";
import type { BankEqAccount, BankSyncDiff } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/internal/officerapi/models";
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

// Mirrors internal/bankexport/moves.go's isSharedContainerName — a
// designated position's owner is the character for personal containers,
// or the EQ account for SharedBank ones, and that's derivable purely from
// the container's own name.
function isSharedContainer(name: string): boolean {
  return name.startsWith("SharedBank");
}

function guildSlotCount(exp: BankCharacterExport): number {
  const personal = [...(exp.bags ?? []), ...(exp.bank ?? [])];
  const shared = exp.isSharedBankHolder ? (exp.sharedBank ?? []) : [];
  let count = 0;
  for (const c of [...personal, ...shared]) {
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
type Diff = { characterId: number; added: DiffRow[]; removed: DiffRow[]; changed: { before: DiffRow; after: DiffRow }[]; unchanged: number };

function normalizeDiff(d: BankSyncDiff): Diff {
  return { characterId: d.characterId, added: d.added ?? [], removed: d.removed ?? [], changed: d.changed ?? [], unchanged: d.unchanged };
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

  const [accountEditor, setAccountEditor] = useState<{ id?: number; label: string; characterIds: number[]; holderId: number | null } | null>(null);
  const [accountSaving, setAccountSaving] = useState(false);
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
  const accounts = state?.accounts ?? [];
  const suggested = state?.suggestedGroups ?? [];
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

  const accountByCharacterId = useMemo(() => {
    const map = new Map<number, BankEqAccount>();
    for (const acc of accounts) for (const id of acc.characterIds ?? []) map.set(id, acc);
    return map;
  }, [accounts]);

  const groupedCharacterIds = useMemo(() => new Set(accounts.flatMap((a) => a.characterIds ?? [])), [accounts]);
  void groupedCharacterIds; // reserved for a future "ungrouped mule" hint — not otherwise read yet

  const current = exports.find((e) => e.character === selected) ?? null;
  const totalWarnings = exports.reduce((sum, e) => sum + (e.moveWarnings ?? []).length, 0);

  // Flagging something guild is the risky direction (unflagging just stops
  // it being uploaded next sync — always safe). Two cases get a
  // confirmation first, since a mistake here means the wrong thing looks
  // like guild property: a SharedBank container (affects every character
  // sharing the EQ account, not just this one) and a personal container on
  // a character that isn't a mule (a played main/alt's own bank, not a
  // dedicated guild-bank holder — easy to flag your own gear by accident).
  // Per-item toggles are deliberately NOT confirmed — one item is a much
  // smaller blast radius than a whole bag.
  type PendingConfirm =
    | { kind: "toggleContainer"; exp: BankCharacterExport; isShared: boolean; container: BankContainer }
    | { kind: "markAll"; exp: BankCharacterExport; scope: "bank" | "bags" }
    | { kind: "clearAllPersonal"; exp: BankCharacterExport };
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  async function performToggleContainer(exp: BankCharacterExport, isShared: boolean, container: BankContainer) {
    const key = `${exp.character}:${container.container}`;
    setSavingKey(key);
    setError(null);
    const nextGuild = !container.guild;
    const seed = containerSeed(container);
    try {
      if (isShared) {
        await ToggleBankContainer(0, exp.eqAccountId!, container.container, nextGuild, seed.itemId, seed.itemName);
      } else {
        await ToggleBankContainer(exp.rosterCharacterId!, 0, container.container, nextGuild, seed.itemId, seed.itemName);
      }
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(null);
    }
  }

  function toggleContainer(exp: BankCharacterExport, isShared: boolean, container: BankContainer) {
    if (exp.rosterCharacterId === null) return;
    if (isShared && (!exp.isSharedBankHolder || exp.eqAccountId === null)) return;

    const turningOn = !container.guild;
    if (turningOn && (isShared || exp.rosterCharType !== "mule")) {
      setPendingConfirm({ kind: "toggleContainer", exp, isShared, container });
      return;
    }
    void performToggleContainer(exp, isShared, container);
  }

  async function toggleItem(exp: BankCharacterExport, isShared: boolean, container: BankContainer, slotIndex: number, currentGuild: boolean, itemId: number, itemName: string) {
    if (exp.rosterCharacterId === null) return;
    if (isShared && (!exp.isSharedBankHolder || exp.eqAccountId === null)) return;
    const key = `${exp.character}:${container.container}:${slotIndex}`;
    setSavingKey(key);
    setError(null);
    try {
      if (isShared) {
        await ToggleBankItem(0, exp.eqAccountId!, container.container, slotIndex, !currentGuild, itemId, itemName);
      } else {
        await ToggleBankItem(exp.rosterCharacterId, 0, container.container, slotIndex, !currentGuild, itemId, itemName);
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
      await MarkAllContainersGuild(exp.rosterCharacterId, 0, seeds);
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
        await performToggleContainer(pendingConfirm.exp, pendingConfirm.isShared, pendingConfirm.container);
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
      await ClearAllBankDesignations(exp.rosterCharacterId, 0);
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
    // drops every personal Bank/Bags designation this character has,
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
    const shared = isSharedContainer(w.container);
    if (shared && (!exp.isSharedBankHolder || exp.eqAccountId === null)) return;
    const key = `${exp.character}:${w.container}:${w.slotIndex}:resolve`;
    setResolvingKey(key);
    setError(null);
    try {
      await ResolveBankMove({
        characterId: shared ? 0 : exp.rosterCharacterId,
        eqAccountId: shared ? exp.eqAccountId! : 0,
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
      setSyncMessage(
        `Synced ${normalized.length} character${normalized.length === 1 ? "" : "s"}, ${totalRows} row(s) total.` +
          (blockedCount > 0 ? ` ${blockedCount} character${blockedCount === 1 ? "" : "s"} skipped — resolve their bag warnings and sync again.` : ""),
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

  function startNewAccount(names: string[]) {
    const ids = names.map((n) => exports.find((e) => e.character === n)?.rosterCharacterId).filter((id): id is number => id !== null && id !== undefined);
    setAccountEditor({ label: names.join(" & "), characterIds: ids, holderId: ids[0] ?? null });
  }

  function startEditAccount(acc: BankEqAccount) {
    setAccountEditor({ id: acc.id, label: acc.label, characterIds: [...(acc.characterIds ?? [])], holderId: acc.sharedBankHolderCharacterId });
  }

  async function saveAccount() {
    if (!accountEditor || accountEditor.holderId === null || accountEditor.characterIds.length === 0) return;
    setAccountSaving(true);
    setError(null);
    try {
      await SaveBankEqAccount({
        id: accountEditor.id,
        label: accountEditor.label,
        characterIds: accountEditor.characterIds,
        sharedBankHolderCharacterId: accountEditor.holderId,
      });
      setAccountEditor(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAccountSaving(false);
    }
  }

  async function deleteAccount(id: number) {
    setAccountSaving(true);
    setError(null);
    try {
      await DeleteBankEqAccount(id);
      setAccountEditor(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAccountSaving(false);
    }
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
          {(accounts.length > 0 || suggested.length > 0) && (
            <div className="bank-sidebar-section">
              <div className="bank-sidebar-title">EQ Accounts</div>
              {accounts.map((acc) => (
                <div key={acc.id} className="bank-account-card">
                  <div className="bank-account-card-header">
                    <strong>{acc.label}</strong>
                    <button className="secondary" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => startEditAccount(acc)}>
                      Edit
                    </button>
                  </div>
                  <div className="bank-account-card-members">
                    {(acc.characterIds ?? []).map((id) => (
                      <span key={id} className={id === acc.sharedBankHolderCharacterId ? "badge leading" : "badge superseded"}>
                        {nameByCharacterId.get(id) ?? `#${id}`}
                        {id === acc.sharedBankHolderCharacterId ? " (holder)" : ""}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              {suggested.map((g) => {
                const names = g.characterNames ?? [];
                return (
                  <div key={names.join(",")} className="bank-account-card bank-account-card-suggested">
                    <div className="bank-account-card-header">
                      <span>Same account? {names.join(", ")}</span>
                      <button className="secondary" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => startNewAccount(names)}>
                        Confirm
                      </button>
                    </div>
                  </div>
                );
              })}
              <button className="secondary" style={{ fontSize: 12 }} onClick={() => setAccountEditor({ label: "", characterIds: [], holderId: null })}>
                + New account group
              </button>
            </div>
          )}
          {accounts.length === 0 && suggested.length === 0 && exports.length > 1 && (
            <button className="secondary" style={{ fontSize: 12, marginBottom: 8 }} onClick={() => setAccountEditor({ label: "", characterIds: [], holderId: null })}>
              + New EQ account group
            </button>
          )}

          <div className="bank-sidebar-section">
            <div className="bank-sidebar-title">Characters</div>
            {exports.map((exp) => {
              const account = exp.rosterCharacterId !== null ? accountByCharacterId.get(exp.rosterCharacterId) : undefined;
              const slots = guildSlotCount(exp);
              const warnCount = (exp.moveWarnings ?? []).length;
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
                  </div>
                  <div className="bank-char-row-meta">
                    {slots} guild slot{slots === 1 ? "" : "s"} · exported {timeAgo(exp.exportedAt)}
                    {account && <span> · {account.label}</span>}
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
              onResolveWarning={resolveWarning}
              sharedOwnerLabel={
                current.eqAccountId !== null && !current.isSharedBankHolder
                  ? nameByCharacterId.get(accountByCharacterId.get(current.rosterCharacterId ?? -1)?.sharedBankHolderCharacterId ?? -1)
                  : undefined
              }
            />
          )}
        </div>
      </div>

      {accountEditor && (
        <div className="bank-modal-backdrop" onClick={() => !accountSaving && setAccountEditor(null)}>
          <div className="bank-modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{accountEditor.id ? "Edit EQ account group" : "New EQ account group"}</h3>
            <label className="bank-modal-field">
              <span>Label</span>
              <input
                type="text"
                value={accountEditor.label}
                onChange={(e) => setAccountEditor({ ...accountEditor, label: e.target.value })}
                placeholder="e.g. Aransur's mule account"
              />
            </label>
            <div className="bank-modal-field">
              <span>Members</span>
              <div className="bank-modal-checklist">
                {exports
                  .filter((e) => e.rosterCharacterId !== null)
                  .map((e) => {
                    const id = e.rosterCharacterId as number;
                    const checked = accountEditor.characterIds.includes(id);
                    return (
                      <label key={id} className="bank-modal-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const ids = checked ? accountEditor.characterIds.filter((x) => x !== id) : [...accountEditor.characterIds, id];
                            setAccountEditor({
                              ...accountEditor,
                              characterIds: ids,
                              holderId: accountEditor.holderId !== null && ids.includes(accountEditor.holderId) ? accountEditor.holderId : (ids[0] ?? null),
                            });
                          }}
                        />
                        {e.character}
                      </label>
                    );
                  })}
              </div>
            </div>
            <label className="bank-modal-field">
              <span>SharedBank holder</span>
              <select
                value={accountEditor.holderId ?? ""}
                onChange={(e) => setAccountEditor({ ...accountEditor, holderId: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">— pick a member —</option>
                {accountEditor.characterIds.map((id) => (
                  <option key={id} value={id}>
                    {nameByCharacterId.get(id) ?? `#${id}`}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-actions" style={{ justifyContent: "space-between" }}>
              {accountEditor.id ? (
                <button className="danger" onClick={() => deleteAccount(accountEditor.id!)} disabled={accountSaving}>
                  Delete group
                </button>
              ) : (
                <span />
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <button className="secondary" onClick={() => setAccountEditor(null)} disabled={accountSaving}>
                  Cancel
                </button>
                <button
                  className="primary"
                  onClick={saveAccount}
                  disabled={accountSaving || !accountEditor.label.trim() || accountEditor.characterIds.length === 0 || accountEditor.holderId === null}
                >
                  {accountSaving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
        title={pendingConfirm?.kind === "clearAllPersonal" ? "Clear all personal designations?" : "Flag as guild property?"}
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
          <strong>Blocked — resolve bag warnings first:</strong>{" "}
          {blocked.map((b) => `${b.character} (${b.warnings})`).join(", ")}
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
    const containers = [...(exp.bags ?? []), ...(exp.bank ?? [])];
    const flaggedContainers = containers.filter((c) => c.guild).length;
    const flaggedItems = containers.flatMap((c) => c.items ?? []).filter((i) => i.guild).length;
    const total = flaggedContainers + flaggedItems;
    return (
      <span>
        Clear all {total} personal (Bank/Bags) designation{total === 1 ? "" : "s"} on <strong>{exp.character}</strong>?
        This unflags every whole-bag and per-item guild designation on this character — Shared Bank designations are
        untouched. There&apos;s no undo besides re-flagging each one by hand.
      </span>
    );
  }
  if (pending.kind === "toggleContainer" && pending.isShared) {
    return (
      <span>
        Flag <strong>{pending.container!.container}</strong> as guild property? This is <strong>{exp.character}</strong>&apos;s account-wide{" "}
        <strong>Shared Bank</strong> — every character sharing this EQ account will have this slot&apos;s contents treated as guild
        bank on the next sync, not just {exp.character}.
      </span>
    );
  }
  if (pending.kind === "toggleContainer") {
    return (
      <span>
        Flag <strong>{pending.container!.container}</strong> on <strong>{exp.character}</strong> as guild property?{" "}
        {exp.character} isn&apos;t marked as a mule ({exp.rosterCharType}) — double-check this slot doesn&apos;t hold{" "}
        {exp.character}&apos;s own gear before syncing.
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
        <label className="bank-guild-switch" title={disabled ? `Toggle on ${isShared ? "the SharedBank holder" : "this character"}` : undefined}>
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
                    disabled={disabled || container.guild || itemSaving}
                    title={container.guild ? "Already covered by the whole-bag flag" : undefined}
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
  sharedOwnerLabel,
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
  sharedOwnerLabel?: string;
}) {
  const bulkSaving = savingKey === `${exp.character}:__bulk`;
  const warnings = exp.moveWarnings ?? [];

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

      <div className="toolbar">
        <button className="secondary" style={{ fontSize: 12 }} onClick={() => onMarkAll(exp, "bank")} disabled={bulkSaving}>
          Mark all Bank slots guild
        </button>
        <button className="secondary" style={{ fontSize: 12 }} onClick={() => onMarkAll(exp, "bags")} disabled={bulkSaving}>
          Mark all Bags guild
        </button>
        <button className="secondary" style={{ fontSize: 12 }} onClick={() => onClearAll(exp)} disabled={bulkSaving}>
          Clear all personal designations
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
            {!exp.isSharedBankHolder && sharedOwnerLabel && (
              <span style={{ color: "#6b7280", fontWeight: 400, fontSize: 12 }}> — toggle on {sharedOwnerLabel}, the account's holder</span>
            )}
            {exp.eqAccountId === null && (
              <span style={{ color: "#6b7280", fontWeight: 400, fontSize: 12 }}> — group this character into an EQ account to sync it</span>
            )}
          </summary>
          <div className="bank-container-grid">
            {(exp.sharedBank ?? []).map((c) => (
              <ContainerCard
                key={c.container}
                exp={exp}
                container={c}
                isShared={true}
                hideEmpty={hideEmpty}
                disabled={!exp.isSharedBankHolder}
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
