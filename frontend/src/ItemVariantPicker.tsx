import type { ItemChoice } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/models";

// Some item names have more than one item id in quarm.db (e.g. two "Carved
// Bone Ring"s — Crusader Kezzal's in The Grey and Terris Thule's NO DROP
// one). The app picks the copy from the officer's log (recent kills, then
// zone, then the highest-level drop — see itemchoice.go); this lets the
// officer check or change it. The id decides the grats link and the item
// the site links to. Renders nothing for a name with a single id.
export function ItemVariantPicker({ choice, onPick }: { choice: ItemChoice | null; onPick: (itemId: number) => void }) {
  const variants = choice?.variants ?? [];
  if (!choice || variants.length < 2) return null;

  const killed = choice.killed ?? [];
  let hint: string;
  switch (choice.reason) {
    case "kill":
      hint = `matched a recent kill${killed.length > 0 ? ` (${killed.slice(0, 3).join(", ")})` : ""}`;
      break;
    case "zone":
      hint = `matched your zone (${choice.zone})`;
      break;
    case "picked":
      hint = "picked by you";
      break;
    default:
      hint = choice.ambiguous ? "couldn't tell which copy dropped — check this is the right one" : "default copy";
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 12 }}>
      <span style={{ color: choice.ambiguous ? "#f59e0b" : "#9ca3af" }}>
        {choice.ambiguous ? "⚠ " : ""}
        {variants.length} items share this name:
      </span>
      <select value={choice.itemId} onChange={(e) => onPick(Number(e.target.value))} style={{ fontSize: 12 }}>
        {variants.map((v) => {
          const zones = v.zones ?? [];
          const where = zones.length > 0 ? zones.slice(0, 2).join(", ") + (zones.length > 2 ? "…" : "") : v.level > 0 ? "unknown zone" : "doesn't drop";
          return (
            <option key={v.id} value={v.id}>
              #{v.id} · {where}
              {v.level > 0 ? ` · lvl ${v.level} drop` : ""}
            </option>
          );
        })}
      </select>
      <span style={{ color: choice.ambiguous ? "#f59e0b" : "#6b7280" }}>{hint}</span>
    </span>
  );
}
