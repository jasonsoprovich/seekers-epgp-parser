import { useCallback, useEffect, useMemo, useState } from "react";
import { FetchRoster, LinkCharacter } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";
import type { Character } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/internal/officerapi/models";
import { invalidateOfficerData, useOfficerDataGeneration } from "./officerData";

export type ResolvedCharacter = { mainCharacterName: string | null; priorityRating: number | null; matched: boolean };

// Module-level cache shared by every useRoster() call — Attendance, Bids and
// Manual Entry each mount their own instance, and switching tabs
// unmounts/remounts the panel, so without this every tab switch re-hit
// /api/officer/characters (a real D1 read + counts against the key's rate
// limit) for a roster that changes only when this app itself links/creates
// a character. Session-lifetime cache, no TTL.
//
// The shared officer-data generation (officerData.ts) forces a refetch: a
// first-load failure (blank/bad key at launch, or a cold-Worker timeout in
// the startup fetch stampede) was otherwise sticky for the whole session —
// the fetch ran once in a `useEffect([])`, and a panel that never remounted
// (Manual Entry's adjust tab, Browse) kept showing the stale error even
// after the officer fixed the key. Saving a key, or clicking Retry, bumps
// the generation.
let rosterCache: Character[] | null = null;
let rosterPromise: Promise<Character[]> | null = null;

function buildIndex(roster: Character[]): Map<string, Character> {
  return new Map(roster.map((c) => [c.name.toLowerCase(), c]));
}

function resolveWith(index: Map<string, Character>, name: string): ResolvedCharacter {
  const c = index.get(name.trim().toLowerCase());
  if (!c) return { mainCharacterName: null, priorityRating: null, matched: false };
  const mainCharacterName = c.charType === "alt" && c.mainCharacterName ? c.mainCharacterName : c.name;
  return { mainCharacterName, priorityRating: c.priorityRating ?? null, matched: true };
}

// Fetched once per app session (cached — see rosterCache above) and
// resolved client-side per row, so fixing a typo'd name in an editable
// table updates its Main/Priority columns immediately without another
// round trip to the site.
export function useRoster() {
  const [characters, setCharacters] = useState<Character[]>(rosterCache ?? []);
  const [byLowerName, setByLowerName] = useState<Map<string, Character>>(() => buildIndex(rosterCache ?? []));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const gen = useOfficerDataGeneration();

  useEffect(() => {
    let cancelled = false;

    if (rosterCache) {
      setCharacters(rosterCache);
      setByLowerName(buildIndex(rosterCache));
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    if (!rosterPromise) rosterPromise = FetchRoster().then((r) => r ?? []);
    rosterPromise
      .then((roster) => {
        rosterCache = roster;
        if (cancelled) return;
        setCharacters(roster);
        setByLowerName(buildIndex(roster));
      })
      .catch((err) => {
        // Drop the shared promise so the next mount, or an explicit
        // reload(), retries rather than re-await a promise that's already
        // rejected.
        rosterPromise = null;
        if (cancelled) return;
        setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [gen]);

  function resolve(name: string): ResolvedCharacter {
    return resolveWith(byLowerName, name);
  }

  // Fetch the roster fresh (bypassing the session cache) and return a
  // resolver bound to that data. The Bids tab calls this right before
  // Determine Winner so priority is post-any-GP-charge from an item another
  // officer just finalized — otherwise a high-priority main could be handed
  // a second item off a stale (pre-charge) number before EPGP catches up.
  // Also updates the shared cache + this hook's state for subsequent reads.
  const refetch = useCallback(async (): Promise<(name: string) => ResolvedCharacter> => {
    const fresh = await FetchRoster().then((r) => r ?? []);
    rosterCache = fresh;
    const idx = buildIndex(fresh);
    setCharacters(fresh);
    setByLowerName(idx);
    setError(null);
    return (name: string) => resolveWith(idx, name);
  }, []);

  const mains = useMemo(() => characters.filter((c) => c.charType === "main"), [characters]);

  // Explicit retry for the error state — clears the cache and forces every
  // mounted useRoster() (and the point-values fetch on Manual Entry) to
  // refetch, same path SettingsPanel uses after a key save.
  const reload = useCallback(() => {
    rosterCache = null;
    rosterPromise = null;
    invalidateOfficerData();
  }, []);

  // Resolves a "no match" name the site roster has never seen — attaches it
  // as a new alt of mainCharacterId, or as a brand-new main when null.
  // Merges the created character straight into local state so the row that
  // triggered this resolves immediately, without a full FetchRoster.
  async function createCharacter(name: string, mainCharacterId: number | null): Promise<Character> {
    const created = await LinkCharacter(name, mainCharacterId);
    if (rosterCache) rosterCache = [...rosterCache, created];
    setCharacters((prev) => [...prev, created]);
    setByLowerName((prev) => new Map(prev).set(created.name.toLowerCase(), created));
    return created;
  }

  return { resolve, refetch, characters, mains, createCharacter, error, loading, reload, loaded: byLowerName.size > 0 };
}

// Called by SettingsPanel after SaveSettings — the key every /api/officer/*
// call depends on just changed, so drop the roster cache and re-run every
// subscribed fetch.
export function invalidateRoster() {
  rosterCache = null;
  rosterPromise = null;
  invalidateOfficerData();
}
