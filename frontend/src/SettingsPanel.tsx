import { useEffect, useState } from "react";
import { Events } from "@wailsio/runtime";
import {
  DetectedLogs,
  FetchGuildSettings,
  GetLogPath,
  GetSettings,
  OpenAppKeyPage,
  SaveSettings,
  SelectGameDir,
  SelectLogFile,
  SetAutoDetectBids,
  TestConnection,
} from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";
import type { GameDirInfo } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/models";
import type { Settings as GuildSettings } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/internal/officerapi/models";
import { invalidateRoster } from "./useRoster";

export function SettingsPanel({
  onLogPathChange,
  onConnectionChanged,
  onRunSetup,
}: {
  onLogPathChange: (path: string) => void;
  onConnectionChanged?: () => void;
  onRunSetup?: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [logPath, setLogPath] = useState("");
  const [gameDir, setGameDir] = useState<GameDirInfo | null>(null);
  const [gameDirError, setGameDirError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
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
    refreshDetectedLogs();
    refreshGuildSettings();
  }, []);

  // The active-character watcher swaps the followed log on its own when the
  // officer changes toons mid-raid — keep this screen in sync when it does.
  useEffect(() => {
    return Events.On("log:active", (ev: { data?: { path?: string } }) => {
      if (ev?.data?.path) setLogPath(ev.data.path);
      refreshDetectedLogs();
    });
  }, []);

  async function refreshDetectedLogs() {
    setGameDirError(null);
    try {
      const info = await DetectedLogs();
      setGameDir(info.gameDir ? info : null);
    } catch (err) {
      setGameDirError(String(err));
    }
  }

  async function onPickGameDir() {
    setGameDirError(null);
    try {
      const info = await SelectGameDir();
      setGameDir(info.gameDir ? info : null);
      if (info.activePath) {
        setLogPath(info.activePath);
        onLogPathChange(info.activePath);
      }
    } catch (err) {
      setGameDirError(String(err));
    }
  }

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
  // seekersofsouls.com/epgp/settings.
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
      // The key backing every /api/officer/* call just changed — drop the
      // session roster cache so panels that fetched it under the old (or no)
      // key refetch instead of staying stuck on a stale auth error.
      invalidateRoster();
      setSaved(true);
      onConnectionChanged?.();
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
      invalidateRoster();
      const count = await TestConnection();
      setTestResult(`Connected — pulled ${count} character${count === 1 ? "" : "s"} from the roster.`);
      await refreshGuildSettings();
    } catch (err) {
      setTestError(String(err));
    } finally {
      setPending(false);
      onConnectionChanged?.();
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
    <div className="settings">
      <div className="panel-header">
        <h2>Settings</h2>
        {onRunSetup && (
          <button className="secondary" onClick={onRunSetup}>
            Run setup wizard
          </button>
        )}
      </div>

      {/* --- EverQuest folder --- */}
      <section className="form-card settings-card">
        <h3>EverQuest folder</h3>
        <p className="hint">
          Point at your EverQuest folder (or its Logs folder). The app follows whichever character you&apos;re playing —
          no need to re-pick when you swap to an alt for a raid.
        </p>
        <div className="settings-row">
          <button className="secondary" onClick={onPickGameDir}>
            Select EverQuest Folder
          </button>
          {gameDir && (
            <button className="secondary" onClick={refreshDetectedLogs}>
              Rescan
            </button>
          )}
          <span className="path">{gameDir?.gameDir || "Not set"}</span>
        </div>
        {gameDirError && <div className="error">{gameDirError}</div>}
        {gameDir && (gameDir.logs?.length ?? 0) > 0 && (
          <table className="char-list col-fixed" style={{ marginTop: 12 }}>
            <colgroup>
              <col style={{ width: "34%" }} />
              <col style={{ width: "22%" }} />
              <col style={{ width: "24%" }} />
              <col style={{ width: "20%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Character</th>
                <th>Server</th>
                <th>Last written</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(gameDir.logs ?? []).map((l) => (
                <tr key={l.path} className={l.path === logPath ? "active" : ""}>
                  <td>{l.character}</td>
                  <td>{l.server}</td>
                  <td>{new Date(l.modifiedAt).toLocaleString()}</td>
                  <td>{l.path === logPath ? "watching" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <button
          type="button"
          className="link-toggle"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? "▾" : "▸"} Advanced: watch one specific log file instead
        </button>
        {showAdvanced && (
          <div style={{ marginTop: 8 }}>
            <div className="settings-row">
              <button className="secondary" onClick={onPickLogFile}>
                Choose file…
              </button>
              <span className="path">{logPath || "none"}</span>
            </div>
            <p className="hint" style={{ marginBottom: 0 }}>
              Pins that file and turns off character auto-detection until you pick an EverQuest folder again. Only needed
              if your logs live somewhere non-standard.
            </p>
          </div>
        )}
      </section>

      {/* --- Connection --- */}
      <section className="form-card settings-card">
        <h3>Site connection</h3>
        <label className="field">
          <span className="field-label">API key</span>
          <input
            type="password"
            placeholder="Generate one on the site, then paste it here"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setSaved(false);
              setTestResult(null);
              setTestError(null);
            }}
          />
        </label>
        <div className="settings-row">
          <button className="primary" onClick={onSave} disabled={pending}>
            {saved ? "Saved" : "Save"}
          </button>
          <button className="secondary" onClick={onTest} disabled={pending || !apiKey.trim()}>
            {pending ? "Testing…" : "Test Connection"}
          </button>
          <button className="secondary" onClick={() => OpenAppKeyPage()}>
            Generate an API key on the site ↗
          </button>
        </div>
        {testResult && <div className="success">{testResult}</div>}
        {testError && <div className="error">{testError}</div>}

        <label className="field field-inline" style={{ marginTop: 14 }}>
          <input
            type="checkbox"
            checked={autoDetectBids}
            onChange={(e) => onToggleAutoDetect(e.target.checked)}
          />
          <span>
            Auto-start bid rounds from log announcements
            <span className="hint" style={{ display: "block", margin: "2px 0 0" }}>
              When you say &quot;&lt;item&gt; send tells&quot; in chat, the Bids tab starts that round on its own.
            </span>
          </span>
        </label>
      </section>

      {/* --- Guild settings (read-only) --- */}
      <section className="form-card settings-card">
        <div className="panel-header" style={{ marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>Guild settings</h3>
          <button className="secondary" onClick={refreshGuildSettings}>
            Refresh
          </button>
        </div>
        <p className="hint">Read-only — tuned by a leader at seekersofsouls.com/epgp/settings, never hardcoded here.</p>
        {guildSettings ? (
          <dl className="kv">
            <div>
              <dt>EP cap per cycle</dt>
              <dd>{guildSettings.EPCapPerCycle}</dd>
            </div>
            <div>
              <dt>Minimum attendance</dt>
              <dd>{guildSettings.MinAttendance}</dd>
            </div>
            <div>
              <dt>EP decay rate</dt>
              <dd>{guildSettings.EPDecay}</dd>
            </div>
            <div>
              <dt>GP decay rate</dt>
              <dd>{guildSettings.GPDecay}</dd>
            </div>
            <div>
              <dt>Base EP</dt>
              <dd>{guildSettings.BaseEP}</dd>
            </div>
            <div>
              <dt>Base GP</dt>
              <dd>{guildSettings.BaseGP}</dd>
            </div>
            <div>
              <dt>Decay model</dt>
              <dd>{guildSettings.DecayModel}</dd>
            </div>
          </dl>
        ) : (
          guildSettingsError && <div className="error">Couldn&apos;t load guild settings: {guildSettingsError}</div>
        )}
      </section>
    </div>
  );
}
