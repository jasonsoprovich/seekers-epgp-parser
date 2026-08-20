import { useEffect, useState } from "react";
import { FetchRoster } from "../wailsjs/go/main/App";
import { officerapi } from "../wailsjs/go/models";

export type ResolvedCharacter = { mainCharacterName: string | null; priorityRating: number | null; matched: boolean };

// Fetched once per panel mount and resolved client-side per row, so
// fixing a typo'd name in an editable table updates its Main/Priority
// columns immediately without another round trip to the site.
export function useRoster() {
  const [byLowerName, setByLowerName] = useState<Map<string, officerapi.Character>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    FetchRoster()
      .then((roster) => setByLowerName(new Map(roster.map((c) => [c.name.toLowerCase(), c]))))
      .catch((err) => setError(String(err)));
  }, []);

  function resolve(name: string): ResolvedCharacter {
    const c = byLowerName.get(name.trim().toLowerCase());
    if (!c) return { mainCharacterName: null, priorityRating: null, matched: false };
    const mainCharacterName = c.charType === "alt" && c.mainCharacterName ? c.mainCharacterName : c.name;
    return { mainCharacterName, priorityRating: c.priorityRating ?? null, matched: true };
  }

  return { resolve, error, loaded: byLowerName.size > 0 };
}
