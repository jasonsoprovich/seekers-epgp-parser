import { useEffect, useState } from "react";
import { FetchLedger, FetchTotals } from "../wailsjs/go/main/App";
import { officerapi } from "../wailsjs/go/models";
import { useRoster } from "./useRoster";

type SubTab = "ep" | "gp" | "totals" | "characters";
type SortDir = "asc" | "desc";

// Empty values (null/undefined/"") always sort last regardless of
// direction, so flipping a column doesn't scatter unresolved rows
// (e.g. characters with no priority yet) to the top.
function compare(a: unknown, b: unknown, dir: SortDir): number {
  const aEmpty = a === null || a === undefined || a === "";
  const bEmpty = b === null || b === undefined || b === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  const result =
    typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  return dir === "asc" ? result : -result;
}

// Sorts whatever rows are currently loaded — the full set for
// Totals/Characters, but only the current page for the (server-paginated)
// Ledger browser, since /api/officer/ledger has no sort param of its own.
function useSort<T>(accessors: Record<string, (row: T) => unknown>) {
  const [state, setState] = useState<{ key: string; dir: SortDir } | null>(null);

  function sort(rows: T[]): T[] {
    if (!state) return rows;
    const accessor = accessors[state.key];
    return [...rows].sort((a, b) => compare(accessor(a), accessor(b), state.dir));
  }

  function toggle(key: string) {
    setState((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }

  function arrow(key: string): string {
    if (!state || state.key !== key) return "";
    return state.dir === "asc" ? " ▲" : " ▼";
  }

  return { sort, toggle, arrow };
}

function SortableTh({
  label,
  sortKey,
  sort,
}: {
  label: string;
  sortKey: string;
  sort: { toggle: (key: string) => void; arrow: (key: string) => string };
}) {
  return (
    <th onClick={() => sort.toggle(sortKey)} style={{ cursor: "pointer", userSelect: "none" }}>
      {label}
      {sort.arrow(sortKey)}
    </th>
  );
}

// Read-only scaffolding over the same data the website's own /epgp/ledger
// and /roster pages show, so an officer can look something up without
// switching to a browser. Search/pagination only — no editing here (that
// stays on the site, where the audit trail and admin approval gates
// already live).
export function BrowsePanel() {
  const [subTab, setSubTab] = useState<SubTab>("ep");

  return (
    <div>
      <div className="panel-header">
        <h2>Browse</h2>
      </div>
      <div className="toolbar" style={{ marginBottom: 8 }}>
        {(["ep", "gp", "totals", "characters"] as SubTab[]).map((t) => (
          <button
            key={t}
            className={t === subTab ? "primary" : "secondary"}
            onClick={() => setSubTab(t)}
          >
            {t === "ep" ? "EP Ledger" : t === "gp" ? "GP Ledger" : t === "totals" ? "Totals" : "Characters"}
          </button>
        ))}
      </div>
      {(subTab === "ep" || subTab === "gp") && <LedgerBrowser kind={subTab} />}
      {subTab === "totals" && <TotalsBrowser />}
      {subTab === "characters" && <CharactersBrowser />}
    </div>
  );
}

function LedgerBrowser({ kind }: { kind: "ep" | "gp" }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<officerapi.LedgerRow[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sort = useSort<officerapi.LedgerRow>({
    date: (r) => r.occurredAt,
    character: (r) => r.characterName,
    activity: (r) => (kind === "ep" ? r.activity : `${r.itemName || ""} ${r.tier || ""}`),
    points: (r) => r.points,
    source: (r) => r.source,
    recordedBy: (r) => r.enteredByName,
  });

  useEffect(() => {
    setPage(1);
  }, [kind]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    FetchLedger(kind, query, page)
      .then((res) => {
        setRows(res.rows);
        setHasNext(res.hasNext);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [kind, query, page]);

  return (
    <div>
      <div className="toolbar">
        <input
          type="text"
          placeholder={kind === "ep" ? "Character or activity…" : "Character, item, or tier…"}
          defaultValue={query}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setPage(1);
              setQuery((e.target as HTMLInputElement).value);
            }
          }}
          style={{ minWidth: 280 }}
        />
        {loading && <span style={{ color: "#6b7280", fontSize: 13 }}>Loading…</span>}
      </div>
      {error && <div className="error">{error}</div>}
      <table>
        <thead>
          <tr>
            <SortableTh label="Date" sortKey="date" sort={sort} />
            <SortableTh label="Character" sortKey="character" sort={sort} />
            <SortableTh label={kind === "ep" ? "Activity" : "Item / Tier"} sortKey="activity" sort={sort} />
            <SortableTh label="Points" sortKey="points" sort={sort} />
            <SortableTh label="Source" sortKey="source" sort={sort} />
            <SortableTh label="Recorded by" sortKey="recordedBy" sort={sort} />
          </tr>
        </thead>
        <tbody>
          {sort.sort(rows).map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.occurredAt).toLocaleDateString()}</td>
              <td>{r.characterName}</td>
              <td>{kind === "ep" ? r.activity : `${r.itemName || "(no item)"} — ${r.tier}`}</td>
              <td style={{ color: r.points < 0 ? "#f87171" : "#10b981" }}>{r.points}</td>
              <td style={{ color: "#9ca3af" }}>{r.source}</td>
              <td style={{ color: "#9ca3af" }}>{r.enteredByName || "—"}</td>
            </tr>
          ))}
          {rows.length === 0 && !loading && (
            <tr>
              <td colSpan={6} className="empty">
                No rows match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="toolbar" style={{ justifyContent: "flex-end" }}>
        <button className="secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
          ← Prev
        </button>
        <span style={{ color: "#9ca3af", fontSize: 13 }}>Page {page}</span>
        <button className="secondary" onClick={() => setPage((p) => p + 1)} disabled={!hasNext}>
          Next →
        </button>
      </div>
    </div>
  );
}

function TotalsBrowser() {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<officerapi.TotalsRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sort = useSort<officerapi.TotalsRow>({
    character: (r) => r.name,
    main: (r) => r.mainCharacterName,
    status: (r) => r.status,
    ep: (r) => r.ep,
    gp: (r) => r.gp,
    priority: (r) => r.priorityRating,
  });

  useEffect(() => {
    setLoading(true);
    setError(null);
    FetchTotals(query)
      .then(setRows)
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [query]);

  return (
    <div>
      <div className="toolbar">
        <input
          type="text"
          placeholder="Character name…"
          defaultValue={query}
          onKeyDown={(e) => {
            if (e.key === "Enter") setQuery((e.target as HTMLInputElement).value);
          }}
          style={{ minWidth: 280 }}
        />
        {loading && <span style={{ color: "#6b7280", fontSize: 13 }}>Loading…</span>}
      </div>
      {error && <div className="error">{error}</div>}
      <table>
        <thead>
          <tr>
            <SortableTh label="Character" sortKey="character" sort={sort} />
            <SortableTh label="Main" sortKey="main" sort={sort} />
            <SortableTh label="Status" sortKey="status" sort={sort} />
            <SortableTh label="EP" sortKey="ep" sort={sort} />
            <SortableTh label="GP" sortKey="gp" sort={sort} />
            <SortableTh label="Priority" sortKey="priority" sort={sort} />
          </tr>
        </thead>
        <tbody>
          {sort.sort(rows).map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td style={{ color: "#9ca3af" }}>{r.mainCharacterName || "—"}</td>
              <td style={{ color: "#9ca3af" }}>{r.status}</td>
              <td>{r.ep !== undefined ? r.ep.toFixed(1) : "—"}</td>
              <td>{r.gp !== undefined ? r.gp.toFixed(1) : "—"}</td>
              <td>{r.priorityRating !== undefined ? r.priorityRating.toFixed(2) : "—"}</td>
            </tr>
          ))}
          {rows.length === 0 && !loading && (
            <tr>
              <td colSpan={6} className="empty">
                No characters match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CharactersBrowser() {
  const roster = useRoster();
  const [query, setQuery] = useState("");
  const filtered = roster.characters.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));
  const sort = useSort<officerapi.Character>({
    character: (c) => c.name,
    type: (c) => c.charType,
    main: (c) => c.mainCharacterName,
    status: (c) => c.status,
    priority: (c) => c.priorityRating,
  });

  return (
    <div>
      <div className="toolbar">
        <input type="text" placeholder="Character name…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 280 }} />
      </div>
      {roster.error && <div className="error">{roster.error}</div>}
      <table>
        <thead>
          <tr>
            <SortableTh label="Character" sortKey="character" sort={sort} />
            <SortableTh label="Type" sortKey="type" sort={sort} />
            <SortableTh label="Main" sortKey="main" sort={sort} />
            <SortableTh label="Status" sortKey="status" sort={sort} />
            <SortableTh label="Priority" sortKey="priority" sort={sort} />
          </tr>
        </thead>
        <tbody>
          {sort.sort(filtered).map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td style={{ color: "#9ca3af" }}>{c.charType}</td>
              <td style={{ color: "#9ca3af" }}>{c.mainCharacterName || "—"}</td>
              <td style={{ color: "#9ca3af" }}>{c.status}</td>
              <td>{c.priorityRating !== undefined ? c.priorityRating.toFixed(2) : "—"}</td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                No characters match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
