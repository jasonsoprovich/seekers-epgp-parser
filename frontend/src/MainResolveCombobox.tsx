import { useEffect, useMemo, useRef, useState } from "react";
import { useRoster } from "./useRoster";

// Type-to-filter character picker used in the Bids review table, in two
// spots:
//   - a manual row's "Character" field (2026-09-09 feedback: this should
//     be a pick-from-roster control like the Attendance manual add, not a
//     free-text box) — omit `playedName`, the typed text drives the
//     "+ add as new" options and the picked name becomes the bid's
//     character.
//   - the "Main" field of a row whose captured tell doesn't match the
//     roster — pass the captured `playedName`; picking resolves who the
//     GP goes to.
// Either way the three outcomes are the same: link to an existing
// character (no DB write), attach a new alt under a main, or add a new
// main.
export function MainResolveCombobox({
  playedName = "",
  value,
  roster,
  onResolved,
  onError,
}: {
  playedName?: string;
  value?: string;
  roster: ReturnType<typeof useRoster>;
  onResolved: (canonicalName: string) => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState(() => value ?? "");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // The name a "+ add as new alt/main" option would create: the captured
  // tell when this is a Main-column picker, otherwise whatever's typed.
  const nameForNew = (playedName.trim() || query.trim()).trim();

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
      if (match(c.name)) out.push({ key: `e${c.id}`, label: c.name, value: `existing:${c.name}` });
    }
    if (nameForNew) {
      for (const m of roster.mains) {
        if (match(m.name)) out.push({ key: `a${m.id}`, label: `+ "${nameForNew}" as a new alt of ${m.name}`, value: `alt:${m.id}` });
      }
      out.push({ key: "nm", label: `+ "${nameForNew}" as a new main`, value: "new-main" });
    }
    return out.slice(0, 40);
  }, [query, roster.characters, roster.mains, nameForNew]);

  async function choose(value: string) {
    setOpen(false);
    if (value.startsWith("existing:")) {
      const name = value.slice("existing:".length);
      setQuery(name);
      onResolved(name);
      return;
    }
    setBusy(true);
    try {
      if (value === "new-main") {
        const created = await roster.createCharacter(nameForNew, null);
        setQuery(created.name);
        onResolved(created.name);
      } else if (value.startsWith("alt:")) {
        const created = await roster.createCharacter(nameForNew, Number(value.slice("alt:".length)));
        setQuery(created.name);
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
        placeholder={busy ? "Saving…" : "pick a character…"}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        style={{ color: "#f87171", width: "100%" }}
      />
      {open && options.length > 0 && (
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
