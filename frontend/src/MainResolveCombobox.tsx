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
  taken,
}: {
  playedName?: string;
  value?: string;
  roster: ReturnType<typeof useRoster>;
  onResolved: (canonicalName: string) => void;
  onError: (message: string) => void;
  // Lower-cased character names already on other rows of this round —
  // listed but disabled, so the same person can't be added twice by
  // accident (2026-09-10 fix: the review table allowed duplicate rows).
  taken?: Set<string>;
}) {
  const [query, setQuery] = useState(() => value ?? "");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Where to draw the menu. It's position:fixed (viewport coordinates)
  // rather than absolute inside the cell: `table.col-fixed td` is
  // overflow:hidden, which clipped the absolute menu to the row's height —
  // the dropdown was hidden behind the row below it (2026-09-10 screenshot).
  const [menuRect, setMenuRect] = useState<{ top: number; left: number; width: number } | null>(null);

  // Controlled: if the row's characterName is changed from outside (the
  // Main column resolving a typed name to its canonical spelling, or a
  // row being re-keyed), the box shows it. Previously `query` was seeded
  // once from `value` and never updated, so rows could show a stale name.
  useEffect(() => {
    if (value !== undefined) setQuery(value);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    function place() {
      const r = inputRef.current?.getBoundingClientRect();
      if (r) setMenuRect({ top: r.bottom + 2, left: r.left, width: Math.max(r.width, 260) });
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

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

  type Option = { key: string; label: string; value: string; disabled?: boolean };
  const options = useMemo<Option[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (s: string) => q === "" || s.toLowerCase().includes(q);
    const out: Option[] = [];
    for (const c of roster.characters) {
      if (!match(c.name)) continue;
      const isTaken = taken?.has(c.name.toLowerCase()) ?? false;
      out.push({
        key: `e${c.id}`,
        label: isTaken ? `${c.name} — already in this round` : c.name,
        value: `existing:${c.name}`,
        disabled: isTaken,
      });
    }
    if (nameForNew) {
      for (const m of roster.mains) {
        if (match(m.name)) out.push({ key: `a${m.id}`, label: `+ "${nameForNew}" as a new alt of ${m.name}`, value: `alt:${m.id}` });
      }
      out.push({ key: "nm", label: `+ "${nameForNew}" as a new main`, value: "new-main" });
    }
    return out.slice(0, 40);
  }, [query, roster.characters, roster.mains, nameForNew, taken]);

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
        ref={inputRef}
        type="text"
        className="cell-input"
        value={query}
        disabled={busy}
        placeholder={busy ? "Saving…" : "pick a character…"}
        // The WebView's own form-autofill popup was stacking on top of
        // this picker (the second dropdown in the 2026-09-10 screenshot).
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        style={{ color: "#f87171", width: "100%" }}
      />
      {open && options.length > 0 && menuRect && (
        <ul
          style={{
            position: "fixed",
            zIndex: 1000,
            top: menuRect.top,
            left: menuRect.left,
            width: menuRect.width,
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
                disabled={o.disabled}
                onClick={() => void choose(o.value)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  color: o.disabled ? "#6b7280" : "#d1d5db",
                  padding: "6px 8px",
                  fontSize: 12,
                  cursor: o.disabled ? "not-allowed" : "pointer",
                  borderRadius: 4,
                }}
                onMouseEnter={(e) => {
                  if (!o.disabled) e.currentTarget.style.background = "#1e2a44";
                }}
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
