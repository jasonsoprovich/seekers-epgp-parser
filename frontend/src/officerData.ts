import { useEffect, useState } from "react";

// A single "officer data is stale, refetch it" signal shared across panels.
//
// Every panel fires its `/api/officer/*` startup fetches at once when the
// app launches (App.tsx keeps all panels mounted), so a cold Worker or a
// transient timeout can fail some while others succeed — and a bare
// `useEffect([])` fetch that failed then stays failed for the whole session
// with no retry, since the panel never remounts. Two things bump this
// generation so those fetches re-run:
//   - SettingsPanel, right after SaveSettings — the key every call depends
//     on just changed.
//   - a "Retry" button on any panel showing one of those errors.
let generation = 0;
const listeners = new Set<() => void>();

export function invalidateOfficerData() {
  generation += 1;
  for (const notify of listeners) notify();
}

export function officerDataGeneration(): number {
  return generation;
}

// Re-renders the caller whenever invalidateOfficerData() fires; the returned
// number is a stable dependency for a refetch effect.
export function useOfficerDataGeneration(): number {
  const [gen, setGen] = useState(generation);
  useEffect(() => {
    const onInvalidate = () => setGen(generation);
    listeners.add(onInvalidate);
    return () => {
      listeners.delete(onInvalidate);
    };
  }, []);
  return gen;
}
