import { useState } from "react";
import { useRoster } from "./useRoster";

// Dropdown for a row whose captured name doesn't match anything in the
// site roster. Three ways to resolve it: it was just a typo'd version of
// an existing character (pick it, no DB write), it's a new alt of an
// existing main (creates the character, linked), or it's a brand-new main
// (creates the character, unlinked). Matched rows never render this — see
// AttendancePanel/BidsPanel, which only show it when roster.resolve()
// comes back unmatched.
export function NoMatchSelect({
  name,
  roster,
  onResolved,
  onError,
}: {
  name: string;
  roster: ReturnType<typeof useRoster>;
  onResolved: (canonicalName: string) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const trimmedName = name.trim();

  async function handleChange(value: string) {
    if (!value) return;
    if (value.startsWith("existing:")) {
      onResolved(value.slice("existing:".length));
      return;
    }
    setBusy(true);
    try {
      if (value === "new-main") {
        const created = await roster.createCharacter(trimmedName, null);
        onResolved(created.name);
      } else if (value.startsWith("alt:")) {
        const mainId = Number(value.slice("alt:".length));
        const created = await roster.createCharacter(trimmedName, mainId);
        onResolved(created.name);
      }
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <select value="" disabled={busy} onChange={(e) => handleChange(e.target.value)} style={{ color: "#f87171" }}>
      <option value="" disabled>
        {busy ? "Saving…" : trimmedName ? `${trimmedName} — no match` : "— pick character —"}
      </option>
      <optgroup label={trimmedName ? "Fix typo — link to existing character" : "Pick existing character"}>
        {roster.characters.map((c) => (
          <option key={c.id} value={`existing:${c.name}`}>
            {c.name}
          </option>
        ))}
      </optgroup>
      {trimmedName && (
        <>
          <optgroup label="Attach as new alt of">
            {roster.mains.map((m) => (
              <option key={m.id} value={`alt:${m.id}`}>
                {m.name}
              </option>
            ))}
          </optgroup>
          <option value="new-main">+ Add "{trimmedName}" as a new main</option>
        </>
      )}
    </select>
  );
}
