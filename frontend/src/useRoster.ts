import { useEffect, useMemo, useState } from "react";
import { FetchRoster, LinkCharacter } from "../wailsjs/go/main/App";
import { officerapi } from "../wailsjs/go/models";

export type ResolvedCharacter = { mainCharacterName: string | null; priorityRating: number | null; matched: boolean };

// Fetched once per panel mount and resolved client-side per row, so
// fixing a typo'd name in an editable table updates its Main/Priority
// columns immediately without another round trip to the site.
export function useRoster() {
  const [characters, setCharacters] = useState<officerapi.Character[]>([]);
  const [byLowerName, setByLowerName] = useState<Map<string, officerapi.Character>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    FetchRoster()
      .then((roster) => {
        setCharacters(roster);
        setByLowerName(new Map(roster.map((c) => [c.name.toLowerCase(), c])));
      })
      .catch((err) => setError(String(err)));
  }, []);

  function resolve(name: string): ResolvedCharacter {
    const c = byLowerName.get(name.trim().toLowerCase());
    if (!c) return { mainCharacterName: null, priorityRating: null, matched: false };
    const mainCharacterName = c.charType === "alt" && c.mainCharacterName ? c.mainCharacterName : c.name;
    return { mainCharacterName, priorityRating: c.priorityRating ?? null, matched: true };
  }

  const mains = useMemo(() => characters.filter((c) => c.charType === "main"), [characters]);

  // Resolves a "no match" name the site has never seen — attaches it as a
  // new alt of mainCharacterId, or as a brand-new main when null. Merges
  // the created character straight into local state so the row that
  // triggered this resolves immediately, without a full FetchRoster.
  async function createCharacter(name: string, mainCharacterId: number | null): Promise<officerapi.Character> {
    const created = await LinkCharacter(name, mainCharacterId);
    setCharacters((prev) => [...prev, created]);
    setByLowerName((prev) => new Map(prev).set(created.name.toLowerCase(), created));
    return created;
  }

  return { resolve, characters, mains, createCharacter, error, loaded: byLowerName.size > 0 };
}
