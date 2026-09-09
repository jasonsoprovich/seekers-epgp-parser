import { useEffect, useMemo, useRef, useState } from "react";
import { useRoster } from "./useRoster";

// Type-to-filter replacement for NoMatchSelect's raw <select>, used in the
// Bids review table's "Main" column (2026-09-09 sim feedback: the officer
// wanted both name fields to behave like text inputs). The played
// character (`playedName`) is typed in the row's first field; this field
// resolves who the GP actually goes to:
//   - the officer typed the toon slightly wrong -> pick the real character
//     (link as-is, no DB write)
//   - it's a genuinely new alt -> attach it under a main (creates the row)
//   - it's a new main -> add it as one (creates the row)
// Same three outcomes as NoMatchSelect; only the control changed.
export function MainResolveCombobox({
  playedName,
  roster,
  onResolved,
  onError,
}: {
  playedName: string;
  roster: ReturnType<typeof useRoster>;
  onResolved: (canonicalName: string) => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const trimmedPlayed = playedName.trim();

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  type Option = { key: string; label: string; value: string };
  const options = useMemo<Option[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (s: string) => q === "" || s.toLowerCase().includes(q);
    const out: Option[] = [];
    for (const c of roster.characters) {
      if (match(c.name)) out.push({ key: `e${c.id}`, label: `${c.name} — this is the character (fix typo)`, value: `existing:${c.name}` });
    }
    if (trimmedPlayed) {
      for (const m of roster.mains) {
        if (match(m.name)) out.push({ key: `a${m.id}`, label: `+ attach "${trimmedPlayed}" as a new alt of ${m.name}`, value: `alt:${m.id}` });
      }
      if (match(trimmedPlayed)) out.push({ key: "nm", label: `+ add "${trimmedPlayed}" as a new main`, value: "new-main" });
    }
    return out.slice(0, 40);
  }, [query, roster.characters, roster.mains, trimmedPlayed]);

  async function choose(value: string) {
    setOpen(false);
    if (value.startsWith("existing:")) {
      onResolved(value.slice("existing:".length));
      return;
    }
    setBusy(true);
    try {
      if (value === "new-main") {
        const created = await roster.createCharacter(trimmedPlayed, null);
        onResolved(created.name);
      } else if (value.startsWith("alt:")) {
        const created = await roster.createCharacter(trimmedPlayed, Number(value.slice("alt:".length)));
        onResolved(created.name);
      }
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        type="text"
        className="cell-input"
        value={query}
        disabled={busy}
        placeholder={busy ? "Saving…" : trimmedPlayed ? "assign a main…" : "enter the character first"}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        style={{ color: "#f87171", width: "100%" }}
      />
      {open && trimmedPlayed && options.length > 0 && (
        <ul
          style={{
            position: "absolute",
            zIndex: 50,
            top: "100%",
            left: 0,
            right: 0,
            margin: 0,
            padding: 4,
            listStyle: "none",
            background: "#131a26",
            border: "1px solid #2a3550",
            borderRadius: 6,
            maxHeight: 220,
            overflowY: "auto",
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
          }}
        >
          {options.map((o) => (
            <li key={o.key}>
              <button
                type="button"
                onClick={() => void choose(o.value)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  color: "#d1d5db",
                  padding: "6px 8px",
                  fontSize: 12,
                  cursor: "pointer",
                  borderRadius: 4,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#1e2a44")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
