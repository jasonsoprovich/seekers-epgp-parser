import { useEffect, useMemo, useState } from "react";
import { FetchRoster, LinkCharacter } from "../wailsjs/go/main/App";
import { officerapi } from "../wailsjs/go/models";

export type ResolvedCharacter = { mainCharacterName: string | null; priorityRating: number | null; matched: boolean };

// Module-level cache shared by every useRoster() call — Attendance and Bids
// each mount their own instance, and switching tabs unmounts/remounts the
// panel, so without this every tab switch re-hit /api/officer/characters
// (a real D1 read + counts against the key's rate limit) for a roster that
// changes only when this app itself links/creates a character. Session-
// lifetime cache, no TTL: createCharacter() below keeps it in sync going
// forward, so there's nothing else that goes stale under it.
let rosterCache: officerapi.Character[] | null = null;
let rosterPromise: Promise<officerapi.Character[]> | null = null;

function buildIndex(roster: officerapi.Character[]): Map<string, officerapi.Character> {
  return new Map(roster.map((c) => [c.name.toLowerCase(), c]));
}

// Fetched once per app session (cached — see rosterCache above) and
// resolved client-side per row, so fixing a typo'd name in an editable
// table updates its Main/Priority columns immediately without another
// round trip to the site.
export function useRoster() {
  const [characters, setCharacters] = useState<officerapi.Character[]>(rosterCache ?? []);
  const [byLowerName, setByLowerName] = useState<Map<string, officerapi.Character>>(() => buildIndex(rosterCache ?? []));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (rosterCache) return;
    if (!rosterPromise) rosterPromise = FetchRoster();
    rosterPromise
      .then((roster) => {
        rosterCache = roster;
        setCharacters(roster);
        setByLowerName(buildIndex(roster));
      })
      .catch((err) => {
        rosterPromise = null;
        setError(String(err));
      });
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
    if (rosterCache) rosterCache = [...rosterCache, created];
    setCharacters((prev) => [...prev, created]);
    setByLowerName((prev) => new Map(prev).set(created.name.toLowerCase(), created));
    return created;
  }

  return { resolve, characters, mains, createCharacter, error, loaded: byLowerName.size > 0 };
}
