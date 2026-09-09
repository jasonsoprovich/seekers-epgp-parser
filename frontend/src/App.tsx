import { useCallback, useEffect, useState } from "react";
import { Events } from "@wailsio/runtime";
import "./App.css";
import {
  CheckForUpdate,
  GetLogPath,
  GetSettings,
  InstallUpdate,
  OpenAppKeyPage,
  OpenReleasePage,
  TestConnection,
} from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";
import type { UpdateInfo } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/models";
import { AttendancePanel } from "./AttendancePanel";
import { BidsPanel } from "./BidsPanel";
import { BrowsePanel } from "./BrowsePanel";
import { ManualEntryPanel } from "./ManualEntryPanel";
import { SettingsPanel } from "./SettingsPanel";
import { SetupWizard } from "./SetupWizard";

type Tab = "attendance" | "bids" | "manual" | "browse" | "settings";

function App() {
  const [tab, setTab] = useState<Tab>("attendance");
  const [logPath, setLogPath] = useState("");
  const [activeChar, setActiveChar] = useState("");
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState("");
  // null = still loading config; true/false = show the first-run wizard or not.
  const [showWizard, setShowWizard] = useState<boolean | null>(null);
  // Set when a key IS configured but doesn't work — a persistent banner so
  // the officer regenerates it before a raid rather than mid-pull.
  const [keyProblem, setKeyProblem] = useState(false);

  const checkKeyHealth = useCallback(async () => {
    try {
      const s = await GetSettings();
      if (!s.apiKey.trim()) {
        setKeyProblem(false);
        return;
      }
      await TestConnection();
      setKeyProblem(false);
    } catch {
      setKeyProblem(true);
    }
  }, []);

  // First-run gate + key health, once on launch.
  useEffect(() => {
    GetSettings()
      .then((s) => {
        setShowWizard(!s.setupComplete);
        if (s.setupComplete) void checkKeyHealth();
      })
      .catch(() => setShowWizard(false));
  }, [checkKeyHealth]);

  // Refreshed whenever Settings changes it — see SettingsPanel's onLogPathChange.
  useEffect(() => {
    GetLogPath().then((p) => p && setLogPath(p));
  }, []);

  // The active-character watcher re-points the log on its own when the
  // officer swaps toons mid-raid — reflect that in the footer.
  useEffect(() => {
    return Events.On("log:active", (ev: { data?: { path?: string; character?: string; server?: string } }) => {
      if (ev?.data?.path) setLogPath(ev.data.path);
      if (ev?.data?.character) setActiveChar(ev.data.server ? `${ev.data.character} (${ev.data.server})` : ev.data.character);
    });
  }, []);

  // Best-effort — no network, or an unversioned "dev" build, both just
  // mean no banner rather than an error the officer has to deal with.
  useEffect(() => {
    CheckForUpdate()
      .then((info) => info.available && setUpdateInfo(info))
      .catch(() => {});
  }, []);

  // On success the Go side quits the app itself (after spawning the
  // updated process), so "installing" just stays true until the window
  // closes — there's nothing further to reset it to. A failure (e.g. no
  // write permission to the install directory) surfaces here and leaves
  // the manual download link as a fallback.
  function handleInstall() {
    setInstalling(true);
    setInstallError("");
    InstallUpdate().catch((err: unknown) => {
      setInstalling(false);
      setInstallError(err instanceof Error ? err.message : String(err));
    });
  }

  return (
    <div className="app">
      {showWizard === true && (
        <SetupWizard
          onDone={() => {
            setShowWizard(false);
            void checkKeyHealth();
          }}
        />
      )}
      {updateInfo && (
        <div className="update-banner">
          <span>
            A new version ({updateInfo.latest}) is available — you're on {updateInfo.current}.
            {installError && ` Auto-update failed: ${installError}`}
          </span>
          <button className="secondary" onClick={handleInstall} disabled={installing}>
            {installing ? "Installing…" : "Update & restart"}
          </button>
          <button className="secondary" onClick={() => OpenReleasePage(updateInfo.url)}>
            Download it ↗
          </button>
        </div>
      )}
      {keyProblem && (
        <div className="update-banner" style={{ background: "#7c2d12" }}>
          <span>
            Your API key isn&apos;t working — the app can&apos;t reach the site. Generate a fresh one and paste it in Settings
            <strong> before raid</strong> so it doesn&apos;t slow the pull down.
          </span>
          <button className="secondary" onClick={() => setTab("settings")}>
            Open Settings
          </button>
          <button className="secondary" onClick={() => OpenAppKeyPage()}>
            Generate a key ↗
          </button>
        </div>
      )}
      <div className="app-body">
        <div className="sidebar">
          <h1>Seekers EPGP</h1>
          <button className={`nav-button ${tab === "attendance" ? "active" : ""}`} onClick={() => setTab("attendance")}>
            Attendance
          </button>
          <button className={`nav-button ${tab === "bids" ? "active" : ""}`} onClick={() => setTab("bids")}>
            Bids
          </button>
          <button className={`nav-button ${tab === "manual" ? "active" : ""}`} onClick={() => setTab("manual")}>
            Manual Entry
          </button>
          <button className={`nav-button ${tab === "browse" ? "active" : ""}`} onClick={() => setTab("browse")}>
            Browse
          </button>
          <button className={`nav-button ${tab === "settings" ? "active" : ""}`} onClick={() => setTab("settings")}>
            Settings
          </button>
          <div className="log-status">
            {activeChar && <div style={{ color: "#10b981", marginBottom: 2 }}>{activeChar} · watching</div>}
            {logPath ? logPath : "No log file selected — see Settings"}
          </div>
        </div>
        {/* Every panel stays mounted; only the active one is shown. A
            half-finished Attendance capture or an open Bids round is React
            state inside its panel, so unmounting on tab-switch (the old
            `tab === "x" && <Panel />`) threw that away — the officer would
            lose an unsubmitted capture just by glancing at another tab.
            None of the panels poll on a background interval, so keeping
            them all mounted costs one extra startup fetch each, nothing
            ongoing. */}
        <div className="main">
          <div hidden={tab !== "attendance"}>
            <AttendancePanel />
          </div>
          <div hidden={tab !== "bids"}>
            <BidsPanel />
          </div>
          <div hidden={tab !== "manual"}>
            <ManualEntryPanel />
          </div>
          <div hidden={tab !== "browse"}>
            <BrowsePanel />
          </div>
          <div hidden={tab !== "settings"}>
            <SettingsPanel
              onLogPathChange={setLogPath}
              onConnectionChanged={checkKeyHealth}
              onRunSetup={() => setShowWizard(true)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
