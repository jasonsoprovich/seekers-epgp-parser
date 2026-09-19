import { useEffect, useState } from "react";
import { Events } from "@wailsio/runtime";
import {
  ArchiveAndTrimLog,
  AppVersion,
  DetectedLogs,
  FetchGuildSettings,
  GetActiveLogInfo,
  GetLogMaintenanceThresholds,
  GetLogPath,
  GetLogTailStatus,
  GetSettings,
  OpenAppKeyPage,
  SaveSettings,
  SelectGameDir,
  SelectLogFile,
  SetAutoDetectBids,
  SetLogMaintenanceSettings,
  TestConnection,
} from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";
import type {
  ArchiveResultView,
  GameDirInfo,
  LogFileInfoView,
  LogMaintenanceThresholds,
  LogTailStatus,
} from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/models";
import type { Settings as GuildSettings } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/internal/officerapi/models";
import { ConfirmDialog } from "./ConfirmDialog";
import { invalidateRoster } from "./useRoster";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

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
  const [version, setVersion] = useState("");
  // The followed log's size/read progress (remediation plan Phase 2 task
  // 2.5) — mainly a "is the incremental tailer actually working" sanity
  // check, not something an officer needs day-to-day. Refreshed on a slow
  // poll rather than tied to any event, since it just reflects whatever the
  // last capture/poll already read.
  const [tailStatus, setTailStatus] = useState<LogTailStatus | null>(null);

  // Log maintenance ("Archive & Trim" — ported from pq-companion). Size/
  // date info for the currently-watched log only, loaded on demand
  // ("Check Log File") rather than eagerly — it does a bounded content
  // scan, not just a stat, so it's not worth running on every poll.
  const [logThresholds, setLogThresholds] = useState<LogMaintenanceThresholds | null>(null);
  const [activeLogInfo, setActiveLogInfo] = useState<LogFileInfoView | null>(null);
  const [logInfoError, setLogInfoError] = useState<string | null>(null);
  const [logInfoLoading, setLogInfoLoading] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveResult, setArchiveResult] = useState<ArchiveResultView | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [retentionDays, setRetentionDays] = useState(14);
  const [targetMB, setTargetMB] = useState(100);
  const [maintenanceSaved, setMaintenanceSaved] = useState(false);

  useEffect(() => {
    GetSettings().then((s) => {
      setApiKey(s.apiKey);
      // null/undefined (never set) defaults to on — mirrors the Go
      // Settings.AutoDetectBidsEnabled helper.
      setAutoDetectBidsState(s.autoDetectBids ?? true);
    });
    GetLogPath().then(setLogPath);
    AppVersion().then(setVersion).catch(() => {});
    refreshDetectedLogs();
    refreshGuildSettings();
    GetLogMaintenanceThresholds()
      .then((thresholds) => {
        setLogThresholds(thresholds);
        setRetentionDays(thresholds.keepDays);
        setTargetMB(Math.round(thresholds.sizeWarningBytes / (1024 * 1024)));
      })
      .catch(() => {});

    const refreshTailStatus = () => GetLogTailStatus().then(setTailStatus).catch(() => {});
    refreshTailStatus();
    const id = setInterval(refreshTailStatus, 5000);
    return () => clearInterval(id);
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

  async function onCheckLogFile() {
    setLogInfoLoading(true);
    setLogInfoError(null);
    setArchiveResult(null);
    setArchiveError(null);
    try {
      setActiveLogInfo(await GetActiveLogInfo());
    } catch (err) {
      setLogInfoError(String(err));
      setActiveLogInfo(null);
    } finally {
      setLogInfoLoading(false);
    }
  }

  // The button is disabled well before the click reaches here (see
  // recentlyWritten below) — this re-check is just so a stale info screen
  // (checked a while ago, EQ has since written more) doesn't let the click
  // through anyway.
  function onArchiveClick() {
    if (!activeLogInfo) return;
    setArchiveError(null);
    setArchiveConfirmOpen(true);
  }

  async function onArchiveConfirm() {
    if (!activeLogInfo) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      const result = await ArchiveAndTrimLog(activeLogInfo.path);
      setArchiveResult(result);
      setArchiveConfirmOpen(false);
      // The trim changed the live file out from under whatever info we
      // were showing — refresh it so size/dates reflect reality.
      await onCheckLogFile();
      refreshDetectedLogs();
    } catch (err) {
      setArchiveError(String(err));
      setArchiveConfirmOpen(false);
    } finally {
      setArchiving(false);
    }
  }

  async function onSaveLogMaintenance() {
    setArchiveError(null);
    setMaintenanceSaved(false);
    try {
      await SetLogMaintenanceSettings(retentionDays, targetMB);
      const thresholds = await GetLogMaintenanceThresholds();
      setLogThresholds(thresholds);
      setMaintenanceSaved(true);
      setActiveLogInfo(null);
    } catch (err) {
      setArchiveError(String(err));
    }
  }

  const recentlyWritten = activeLogInfo
    ? Date.now() - new Date(activeLogInfo.modifiedAt).getTime() < (logThresholds?.liveWriteWindowMs ?? 2 * 60 * 1000)
    : false;

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
              <col style={{ width: "28%" }} />
              <col style={{ width: "18%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "22%" }} />
              <col style={{ width: "16%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Character</th>
                <th>Server</th>
                <th>Size</th>
                <th>Last written</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(gameDir.logs ?? []).map((l) => {
                const large = logThresholds ? l.size >= logThresholds.sizeWarningBytes : false;
                return (
                  <tr key={l.path} className={l.path === logPath ? "active" : ""}>
                    <td>{l.character}</td>
                    <td>{l.server}</td>
                    <td title={large ? "Large — see Log maintenance below" : undefined}>
                      {formatBytes(l.size)}
                      {large && (
                        <span className="badge large" style={{ marginLeft: 6 }}>
                          large
                        </span>
                      )}
                    </td>
                    <td>{new Date(l.modifiedAt).toLocaleString()}</td>
                    <td>{l.path === logPath ? "watching" : ""}</td>
                  </tr>
                );
              })}
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
        {tailStatus && tailStatus.path && (
          <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
            {formatBytes(tailStatus.size)} read
            {tailStatus.resets > 1 ? ` · reset ${tailStatus.resets - 1} time${tailStatus.resets - 1 === 1 ? "" : "s"} (log cleared or replaced)` : ""}
          </p>
        )}
      </section>

      {/* --- Log maintenance ("Archive & Trim") --- */}
      <section className={`form-card settings-card ${activeLogInfo?.largeFile ? "settings-card-warning" : ""}`}>
        <div className="panel-header" style={{ marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>Log maintenance</h3>
          {activeLogInfo?.largeFile && (
            <span className="badge large" style={{ marginLeft: 8 }}>
              large file detected
            </span>
          )}
        </div>
        <p className="hint">
          A very large log file (an officer's reached ~1 GB once) makes every capture slower to read. "Archive &amp; Trim"
          zips the whole current log to a backup next to it, then keeps recent complete lines up to the configured age and
          size limits. The full original always remains in the backup.
        </p>
        <div className="form-row" style={{ alignItems: "end" }}>
          <label>
            Keep up to (days)
            <input
              type="number"
              min={1}
              max={365}
              value={retentionDays}
              onChange={(e) => {
                setRetentionDays(Number(e.target.value));
                setMaintenanceSaved(false);
              }}
            />
          </label>
          <label>
            Target maximum (MB)
            <input
              type="number"
              min={10}
              max={4096}
              value={targetMB}
              onChange={(e) => {
                setTargetMB(Number(e.target.value));
                setMaintenanceSaved(false);
              }}
            />
          </label>
          <button className="secondary" type="button" onClick={onSaveLogMaintenance}>
            {maintenanceSaved ? "Saved" : "Save limits"}
          </button>
        </div>
        <div className="settings-row">
          <button className="secondary" onClick={onCheckLogFile} disabled={logInfoLoading || !logPath}>
            {logInfoLoading ? "Checking…" : "Check Log File"}
          </button>
          {activeLogInfo && (
            <button
              className="primary"
              onClick={onArchiveClick}
              disabled={archiving || recentlyWritten}
              title={recentlyWritten ? "This log was written to recently — camp out of EverQuest first, then Check Log File again" : undefined}
            >
              Archive &amp; Trim
            </button>
          )}
        </div>
        {logInfoError && <div className="error">{logInfoError}</div>}
        {activeLogInfo && (
          <dl className="kv" style={{ marginTop: 10 }}>
            <div>
              <dt>File</dt>
              <dd className="path">{activeLogInfo.path}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>
                {formatBytes(activeLogInfo.size)}
                {activeLogInfo.largeFile && (
                  <span className="badge large" style={{ marginLeft: 6 }}>
                    large
                  </span>
                )}
              </dd>
            </div>
            {activeLogInfo.oldestEntry && (
              <div>
                <dt>Oldest entry</dt>
                <dd>{new Date(activeLogInfo.oldestEntry).toLocaleString()}</dd>
              </div>
            )}
            {activeLogInfo.newestEntry && (
              <div>
                <dt>Newest entry</dt>
                <dd>{new Date(activeLogInfo.newestEntry).toLocaleString()}</dd>
              </div>
            )}
          </dl>
        )}
        {recentlyWritten && (
          <div className="warning">
            This log was written to in the last couple minutes — EverQuest still has it open. Camp out of the zone, wait a
            bit, then Check Log File again before archiving.
          </div>
        )}
        {archiveError && <div className="error">{archiveError}</div>}
        {archiveResult && (
          <div className="success">
            Archived {formatBytes(archiveResult.originalBytes)} to <span className="path">{archiveResult.backupPath}</span> —
            kept {formatBytes(archiveResult.keptBytes)} live.
          </div>
        )}
      </section>

      <ConfirmDialog
        open={archiveConfirmOpen}
        title="Archive & Trim this log?"
        confirmLabel="Archive & Trim"
        busy={archiving}
        onCancel={() => setArchiveConfirmOpen(false)}
        onConfirm={() => void onArchiveConfirm()}
        body={
          activeLogInfo && (
            <>
              <p style={{ margin: "0 0 8px" }}>
                This zips the entire current log (<strong>{formatBytes(activeLogInfo.size)}</strong>) to a backup file next
                to it, then rewrites the live log to keep at most the last {logThresholds?.keepDays ?? 14} days and about {targetMB} MB.
              </p>
              <p style={{ margin: 0, color: "#9ca3af" }}>
                Nothing is deleted — the full original stays in the backup zip. Make sure you're fully camped out of
                EverQuest first.
              </p>
            </>
          )
        }
      />

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

      <p className="app-version">seekers-epgp-parser {version || "—"}</p>
    </div>
  );
}
