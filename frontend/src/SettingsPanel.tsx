import { useEffect, useState } from "react";
import {
  FetchGuildSettings,
  GetLogPath,
  GetSettings,
  OpenAppKeyPage,
  SaveSettings,
  SelectLogFile,
  SetAutoDetectBids,
  TestConnection,
} from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";
import type { Settings as GuildSettings } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/internal/officerapi/models";

export function SettingsPanel({ onLogPathChange }: { onLogPathChange: (path: string) => void }) {
  const [apiKey, setApiKey] = useState("");
  const [logPath, setLogPath] = useState("");
  const [autoDetectBids, setAutoDetectBidsState] = useState(true);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [guildSettings, setGuildSettings] = useState<GuildSettings | null>(null);
  const [guildSettingsError, setGuildSettingsError] = useState<string | null>(null);

  useEffect(() => {
    GetSettings().then((s) => {
      setApiKey(s.apiKey);
      // null/undefined (never set) defaults to on — mirrors the Go
      // Settings.AutoDetectBidsEnabled helper.
      setAutoDetectBidsState(s.autoDetectBids ?? true);
    });
    GetLogPath().then(setLogPath);
    refreshGuildSettings();
  }, []);

  async function onToggleAutoDetect(enabled: boolean) {
    setAutoDetectBidsState(enabled);
    try {
      await SetAutoDetectBids(enabled);
    } catch {
      setAutoDetectBidsState(!enabled); // revert on failure
    }
  }

  // "Fetch at startup and re-validate at submit" (PLAN.md §4i) — every
  // number here comes from the site, never hardcoded. This screen just
  // surfaces what's currently in force; a leader tunes them at
  // seekers.fetchinglogic.com/epgp/settings.
  async function refreshGuildSettings() {
    setGuildSettingsError(null);
    try {
      setGuildSettings(await FetchGuildSettings());
    } catch (err) {
      // Expected before an API key is saved — not a real error to alarm
      // the officer with on first launch.
      setGuildSettingsError(String(err));
    }
  }

  async function onSave() {
    setPending(true);
    setSaved(false);
    try {
      await SaveSettings(apiKey.trim());
      setSaved(true);
    } finally {
      setPending(false);
    }
  }

  async function onTest() {
    setPending(true);
    setTestResult(null);
    setTestError(null);
    try {
      await SaveSettings(apiKey.trim());
      const count = await TestConnection();
      setTestResult(`Connected — pulled ${count} character${count === 1 ? "" : "s"} from the roster.`);
      await refreshGuildSettings();
    } catch (err) {
      setTestError(String(err));
    } finally {
      setPending(false);
    }
  }

  async function onPickLogFile() {
    const path = await SelectLogFile();
    if (path) {
      setLogPath(path);
      onLogPathChange(path);
    }
  }

  return (
    <div>
      <div className="panel-header">
        <h2>Settings</h2>
      </div>

      <div className="form-grid">
        <label>
          Log File
          <div className="toolbar" style={{ margin: 0 }}>
            <button className="secondary" onClick={onPickLogFile}>
              Select Log File
            </button>
            <span style={{ color: "#9ca3af", fontSize: 13, wordBreak: "break-all" }}>{logPath || "No log file selected"}</span>
          </div>
        </label>

        <label>
          API Key
          <input
            type="password"
            placeholder="Generate one on the site, then paste it here"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              // The key changed — the last "Saved" no longer describes
              // what's in the box.
              setSaved(false);
              setTestResult(null);
              setTestError(null);
            }}
          />
        </label>
        <button className="secondary" onClick={() => OpenAppKeyPage()} style={{ alignSelf: "flex-start" }}>
          Generate an API Key on the site ↗
        </button>

        <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={autoDetectBids}
            onChange={(e) => onToggleAutoDetect(e.target.checked)}
            style={{ width: "auto" }}
          />
          <span>
            Auto-start bid rounds from log announcements
            <span style={{ display: "block", color: "#9ca3af", fontSize: 12 }}>
              When you say "&lt;item&gt; send tells" in chat, the Bids tab starts that round on its own.
            </span>
          </span>
        </label>
      </div>

      <div className="toolbar">
        <button className="primary" onClick={onSave} disabled={pending}>
          {saved ? "Saved" : "Save"}
        </button>
        <button className="secondary" onClick={onTest} disabled={pending || !apiKey.trim()}>
          {pending ? "Testing…" : "Test Connection"}
        </button>
      </div>

      {testResult && <div className="success">{testResult}</div>}
      {testError && <div className="error">{testError}</div>}

      <div className="panel-header" style={{ marginTop: 24 }}>
        <h2>Guild Settings</h2>
        <button className="secondary" onClick={refreshGuildSettings}>
          Refresh
        </button>
      </div>
      <p style={{ color: "#9ca3af", fontSize: 13, marginTop: -8, marginBottom: 12 }}>
        Read-only — tuned by a leader at seekers.fetchinglogic.com/epgp/settings, never hardcoded here.
      </p>
      {guildSettings ? (
        <div className="form-grid">
          <div>EP cap per cycle: {guildSettings.EPCapPerCycle}</div>
          <div>Minimum attendance: {guildSettings.MinAttendance}</div>
          <div>EP decay rate: {guildSettings.EPDecay}</div>
          <div>GP decay rate: {guildSettings.GPDecay}</div>
          <div>Base EP: {guildSettings.BaseEP}</div>
          <div>Base GP: {guildSettings.BaseGP}</div>
          <div>Decay model: {guildSettings.DecayModel}</div>
        </div>
      ) : (
        guildSettingsError && <div className="error">Couldn&apos;t load guild settings: {guildSettingsError}</div>
      )}
    </div>
  );
}
