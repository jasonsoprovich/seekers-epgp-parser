import { useEffect, useState } from "react";

import { FetchGuildSettings, PreviewEpCap } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";
import type { EpCapPreviewRequest } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/internal/officerapi/models";

// The site's per-cycle EP cap (a leader setting, 900 today) clamps any EP
// award to the room a player has left in the cycle — main and alts share one
// cap. The award is still recorded, just with fewer (possibly 0) EP. This is
// the one place the app explains that, so every tab says it the same way:
// before submit ("will add +30 instead of 50") and after ("added +30").
export type CapLine = { name: string; awarded: number; nominal: number; context?: string };

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// The cap is a leader setting, so a result notice (whose submit response
// doesn't carry it) reads it from guild settings — once per session.
let settingsCap: Promise<number | null> | null = null;
function loadSettingsCap(): Promise<number | null> {
  settingsCap ??= FetchGuildSettings()
    .then((s) => (s.EPCapPerCycle > 0 ? s.EPCapPerCycle : null))
    .catch(() => {
      settingsCap = null;
      return null;
    });
  return settingsCap;
}

export function EpCapNotice({ lines, mode, cap }: { lines: CapLine[]; mode: "preview" | "result"; cap?: number | null }) {
  const [fetchedCap, setFetchedCap] = useState<number | null>(null);
  const needCap = lines.length > 0 && !cap;
  useEffect(() => {
    if (!needCap) return;
    let cancelled = false;
    void loadSettingsCap().then((c) => {
      if (!cancelled) setFetchedCap(c);
    });
    return () => {
      cancelled = true;
    };
  }, [needCap]);
  if (lines.length === 0) return null;
  const capValue = cap || fetchedCap;
  const capText = capValue ? `${fmt(capValue)} EP` : "a limited amount of EP";
  const n = lines.length;
  return (
    <div className="warning" style={{ marginBottom: 8, textAlign: "left" }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {mode === "preview"
          ? `EP cap: ${n} award${n === 1 ? "" : "s"} will be lowered automatically`
          : `EP cap: ${n} award${n === 1 ? " was" : "s were"} lowered automatically`}
      </div>
      <div style={{ color: "#d1d5db", marginBottom: 6 }}>
        Each player can earn at most {capText} per cycle (main and alts combined). The site only adds the EP that still
        fits under the cap. Attendance is still recorded for everyone. This is expected, so there's nothing to fix.
      </div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {lines.map((l, i) => (
          <li key={`${l.name}-${l.context ?? ""}-${i}`}>
            <strong>{l.name}</strong>
            {l.context ? <span style={{ color: "#9ca3af" }}> ({l.context})</span> : null}:{" "}
            {mode === "preview" ? "will get " : "got "}
            <strong>+{fmt(l.awarded)} EP</strong> instead of {fmt(l.nominal)}
            <span style={{ color: "#9ca3af" }}>
              {l.awarded <= 0 ? " (already at the cap, so attendance only)" : " (that fills their cap)"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type CapPreview = { status: "idle" | "checking" | "ready" | "unavailable"; lines: CapLine[]; cap: number | null };

const IDLE: CapPreview = { status: "idle", lines: [], cap: null };

// Asks the site which awards the cap will lower. Best-effort: offline or an
// older site without the preview route gives "unavailable" and the officer
// can still submit (the result notice still explains any clamp afterward).
export async function fetchCapPreview(items: EpCapPreviewRequest[], contexts?: string[]): Promise<CapPreview> {
  try {
    const res = (await PreviewEpCap(items)) ?? [];
    const lines: CapLine[] = [];
    let cap: number | null = null;
    res.forEach((item, idx) => {
      if (item.cap != null) cap = item.cap;
      for (const e of item.entries ?? []) {
        if (e.capped) lines.push({ name: e.name, awarded: e.awarded, nominal: e.nominal, context: contexts?.[idx] });
      }
    });
    return { status: "ready", lines, cap };
  } catch {
    return { status: "unavailable", lines: [], cap: null };
  }
}

// Debounced live preview for a form: re-asks whenever `key` changes.
// `items` null means "nothing to preview" (e.g. a GP entry, no character).
export function useCapPreview(items: EpCapPreviewRequest[] | null, key: string): CapPreview {
  const [preview, setPreview] = useState<CapPreview>(IDLE);
  useEffect(() => {
    if (!items) {
      setPreview(IDLE);
      return;
    }
    let cancelled = false;
    setPreview((p) => ({ ...p, status: "checking" }));
    const t = setTimeout(() => {
      void fetchCapPreview(items).then((p) => {
        if (!cancelled) setPreview(p);
      });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return preview;
}
