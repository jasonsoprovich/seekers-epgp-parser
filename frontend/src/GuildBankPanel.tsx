import { useEffect, useMemo, useState } from "react";
import {
  CreateBankMule,
  DeleteBankEqAccount,
  PreviewBankSync,
  SaveBankEqAccount,
  ScanGuildBank,
  SetBankDesignations,
  SubmitBankSync,
} from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";
import type { BankCharacterExport, BankContainer, GuildBankState } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/models";
import type { BankEqAccount, BankSyncDiff } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/internal/officerapi/models";
import { ConfirmDialog } from "./ConfirmDialog";

// The Guild Bank tab (PLAN.md §9/§11 Phase 8.4). Every read comes from a
// fresh ScanGuildBank() call — no local caching between mutations, so a
// toggle saved here or a designation changed by another officer is never
// stale for more than one refresh. The one rule this whole tab exists to
// enforce: a container is never synced unless the officer explicitly
// flagged it guild — see BankContainer's "guild" field and
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

function personalGuildContainers(exp: BankCharacterExport): string[] {
  return [...(exp.bags ?? []), ...(exp.bank ?? [])].filter((c) => c.guild).map((c) => c.container);
}

function sharedGuildContainers(exp: BankCharacterExport): string[] {
  return (exp.sharedBank ?? []).filter((c) => c.guild).map((c) => c.container);
}

function guildSlotCount(exp: BankCharacterExport): number {
  return personalGuildContainers(exp).length + (exp.isSharedBankHolder ? sharedGuildContainers(exp).length : 0);
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

export function GuildBankPanel() {
  const [state, setState] = useState<GuildBankState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [savingContainer, setSavingContainer] = useState<string | null>(null);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [diffs, setDiffs] = useState<Diff[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const [accountEditor, setAccountEditor] = useState<{ id?: number; label: string; characterIds: number[]; holderId: number | null } | null>(null);
  const [accountSaving, setAccountSaving] = useState(false);
  const [muleName, setMuleName] = useState("");
  const [creatingMule, setCreatingMule] = useState(false);

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

  const accountByCharacterId = useMemo(() => {
    const map = new Map<number, BankEqAccount>();
    for (const acc of accounts) for (const id of acc.characterIds ?? []) map.set(id, acc);
    return map;
  }, [accounts]);

  const groupedCharacterIds = useMemo(() => new Set(accounts.flatMap((a) => a.characterIds ?? [])), [accounts]);

  const current = exports.find((e) => e.character === selected) ?? null;

  async function toggleContainer(exp: BankCharacterExport, isShared: boolean, container: string) {
    if (exp.rosterCharacterId === null) return;
    if (isShared && (!exp.isSharedBankHolder || exp.eqAccountId === null)) return;

    const key = `${exp.character}:${container}`;
    setSavingContainer(key);
    setError(null);

    const currentList = isShared ? sharedGuildContainers(exp) : personalGuildContainers(exp);
    const set = new Set(currentList);
    if (set.has(container)) set.delete(container);
    else set.add(container);
    const next = [...set];

    // Optimistic local update.
    setState((prev) => {
      if (!prev) return prev;
      const updateContainers = (list: BankContainer[] | null) =>
        (list ?? []).map((c) => (c.container === container ? { ...c, guild: set.has(container) } : c));
      const exportsNext = (prev.exports ?? []).map((e) => {
        if (e.character !== exp.character) return e;
        if (isShared) return { ...e, sharedBank: updateContainers(e.sharedBank) };
        return { ...e, bags: updateContainers(e.bags), bank: updateContainers(e.bank) };
      });
      return { ...prev, exports: exportsNext };
    });

    try {
      if (isShared) {
        await SetBankDesignations(0, exp.eqAccountId!, next);
      } else {
        await SetBankDesignations(exp.rosterCharacterId, 0, next);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      load(); // resync with the server's real state after a failed save
    } finally {
      setSavingContainer(null);
    }
  }

  async function markAllBank(exp: BankCharacterExport, guild: boolean) {
    if (exp.rosterCharacterId === null) return;
    const otherPersonal = (exp.bags ?? []).filter((c) => c.guild).map((c) => c.container);
    const bankContainers = guild ? (exp.bank ?? []).map((c) => c.container) : [];
    const next = [...new Set([...otherPersonal, ...bankContainers])];
    setSavingContainer(`${exp.character}:__bulk`);
    setError(null);
    try {
      await SetBankDesignations(exp.rosterCharacterId, 0, next);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingContainer(null);
    }
  }

  async function clearAllPersonal(exp: BankCharacterExport) {
    if (exp.rosterCharacterId === null) return;
    setSavingContainer(`${exp.character}:__bulk`);
    setError(null);
    try {
      await SetBankDesignations(exp.rosterCharacterId, 0, []);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingContainer(null);
    }
  }

  async function openPreview() {
    setPreviewOpen(true);
    setPreviewLoading(true);
    setDiffs(null);
    setSyncMessage(null);
    setError(null);
    try {
      const result = await PreviewBankSync();
      setDiffs((result ?? []).map(normalizeDiff));
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
      const result = (await SubmitBankSync())?.map(normalizeDiff) ?? [];
      const totalRows = result.reduce((sum, d) => sum + d.added.length + d.removed.length + d.changed.length + d.unchanged, 0);
      setSyncMessage(`Synced ${result.length} character${result.length === 1 ? "" : "s"}, ${totalRows} row(s) total.`);
      setPreviewOpen(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
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

      {error && (
        <div className="error">
          {error}
        </div>
      )}
      {syncMessage && <div className="success">{syncMessage}</div>}

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
              savingContainer={savingContainer}
              onToggle={toggleContainer}
              onMarkAllBank={markAllBank}
              onClearAll={clearAllPersonal}
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
          ) : !diffs || diffs.length === 0 ? (
            <span>Nothing to sync — no character has any guild-flagged inventory yet.</span>
          ) : (
            <div style={{ maxHeight: 320, overflowY: "auto" }}>
              {diffs.map((d) => (
                <div key={d.characterId} style={{ marginBottom: 12 }}>
                  <strong>{nameByCharacterId.get(d.characterId) ?? `#${d.characterId}`}</strong>{" "}
                  <span style={{ color: "#9ca3af" }}>
                    (+{d.added.length} −{d.removed.length} ~{d.changed.length}, {d.unchanged} unchanged)
                  </span>
                  {d.added.length > 0 && (
                    <div style={{ color: "#10b981", fontSize: 12 }}>+ {d.added.map((r) => r.itemName).join(", ")}</div>
                  )}
                  {d.removed.length > 0 && (
                    <div style={{ color: "#f87171", fontSize: 12 }}>− {d.removed.map((r) => r.itemName).join(", ")}</div>
                  )}
                  {d.changed.length > 0 && (
                    <div style={{ color: "#fbbf24", fontSize: 12 }}>
                      ~ {d.changed.map((c) => `${c.before.itemName} → ${c.after.itemName} (${c.after.quantity})`).join(", ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        }
      />
    </div>
  );
}

function ContainerCard({
  container,
  isShared,
  hideEmpty,
  disabled,
  saving,
  onToggle,
}: {
  container: BankContainer;
  isShared: boolean;
  hideEmpty: boolean;
  disabled: boolean;
  saving: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(true);
  const items = container.items ?? [];
  if (hideEmpty && items.length === 0) return null;

  const label = container.loose
    ? container.container
    : container.bagName
      ? `${container.container} · ${container.bagName}`
      : container.container;

  return (
    <div className={`bank-container-card ${container.guild ? "bank-container-card-guild" : ""}`}>
      <div className="bank-container-card-header">
        <button type="button" className="bank-container-toggle-open" onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} {label}
          {!container.loose && container.capacity > 0 && (
            <span style={{ color: "#6b7280", marginLeft: 6 }}>
              {items.length}/{container.capacity}
            </span>
          )}
        </button>
        <label className="bank-guild-switch" title={disabled ? `Toggle on ${isShared ? "the SharedBank holder" : "this character"}` : undefined}>
          <input type="checkbox" checked={container.guild} disabled={disabled || saving} onChange={onToggle} />
          {saving ? "…" : "Guild"}
        </label>
      </div>
      {open && (
        <div className="bank-item-list">
          {items.length === 0 && <div className="bank-item-empty">(empty)</div>}
          {items.map((item) => (
            <div key={item.slotIndex} className="bank-item">
              <span>{item.itemName}</span>
              {item.quantity > 1 && <span className="bank-item-qty">×{item.quantity}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CharacterDetail({
  exp,
  hideEmpty,
  setHideEmpty,
  savingContainer,
  onToggle,
  onMarkAllBank,
  onClearAll,
  sharedOwnerLabel,
}: {
  exp: BankCharacterExport;
  hideEmpty: boolean;
  setHideEmpty: (v: boolean) => void;
  savingContainer: string | null;
  onToggle: (exp: BankCharacterExport, isShared: boolean, container: string) => void;
  onMarkAllBank: (exp: BankCharacterExport, guild: boolean) => void;
  onClearAll: (exp: BankCharacterExport) => void;
  sharedOwnerLabel?: string;
}) {
  const bulkSaving = savingContainer === `${exp.character}:__bulk`;

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

      <div className="toolbar">
        <button className="secondary" style={{ fontSize: 12 }} onClick={() => onMarkAllBank(exp, true)} disabled={bulkSaving}>
          Mark all Bank slots guild
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
            {(exp.equipped ?? []).map((it) => (
              <div key={it.location} className="bank-item">
                <span style={{ color: "#6b7280" }}>{it.location}:</span> {it.itemName}
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="bank-section">
        <div className="bank-section-title">Bags</div>
        <div className="bank-container-grid">
          {(exp.bags ?? []).map((c) => (
            <ContainerCard
              key={c.container}
              container={c}
              isShared={false}
              hideEmpty={hideEmpty}
              disabled={false}
              saving={savingContainer === `${exp.character}:${c.container}`}
              onToggle={() => onToggle(exp, false, c.container)}
            />
          ))}
        </div>
      </div>

      <div className="bank-section">
        <div className="bank-section-title">Bank</div>
        <div className="bank-container-grid">
          {(exp.bank ?? []).map((c) => (
            <ContainerCard
              key={c.container}
              container={c}
              isShared={false}
              hideEmpty={hideEmpty}
              disabled={false}
              saving={savingContainer === `${exp.character}:${c.container}`}
              onToggle={() => onToggle(exp, false, c.container)}
            />
          ))}
        </div>
      </div>

      {(exp.sharedBank ?? []).length > 0 && (
        <div className="bank-section">
          <div className="bank-section-title">
            Shared Bank
            {!exp.isSharedBankHolder && sharedOwnerLabel && (
              <span style={{ color: "#6b7280", fontWeight: 400, fontSize: 12 }}> — toggle on {sharedOwnerLabel}, the account's holder</span>
            )}
            {exp.eqAccountId === null && (
              <span style={{ color: "#6b7280", fontWeight: 400, fontSize: 12 }}> — group this character into an EQ account to sync it</span>
            )}
          </div>
          <div className="bank-container-grid">
            {(exp.sharedBank ?? []).map((c) => (
              <ContainerCard
                key={c.container}
                container={c}
                isShared={true}
                hideEmpty={hideEmpty}
                disabled={!exp.isSharedBankHolder}
                saving={savingContainer === `${exp.character}:${c.container}`}
                onToggle={() => onToggle(exp, true, c.container)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
