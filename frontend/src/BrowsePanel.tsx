import { useEffect, useState } from "react";
import { FetchLedger, FetchTotals } from "../wailsjs/go/main/App";
import { officerapi } from "../wailsjs/go/models";
import { useRoster } from "./useRoster";

type SubTab = "ep" | "gp" | "totals" | "characters";

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
            <th>Date</th>
            <th>Character</th>
            <th>{kind === "ep" ? "Activity" : "Item / Tier"}</th>
            <th>Points</th>
            <th>Source</th>
            <th>Recorded by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
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
            <th>Character</th>
            <th>Main</th>
            <th>Status</th>
            <th>EP</th>
            <th>GP</th>
            <th>Priority</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
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

  return (
    <div>
      <div className="toolbar">
        <input type="text" placeholder="Character name…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 280 }} />
      </div>
      {roster.error && <div className="error">{roster.error}</div>}
      <table>
        <thead>
          <tr>
            <th>Character</th>
            <th>Type</th>
            <th>Main</th>
            <th>Status</th>
            <th>Priority</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((c) => (
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
