import { useEffect, useState } from "react";
import "./App.css";
import { CheckForUpdate, GetLogPath, InstallUpdate, OpenReleasePage } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";
import type { UpdateInfo } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/models";
import { AttendancePanel } from "./AttendancePanel";
import { BidsPanel } from "./BidsPanel";
import { BrowsePanel } from "./BrowsePanel";
import { ManualEntryPanel } from "./ManualEntryPanel";
import { SettingsPanel } from "./SettingsPanel";

type Tab = "attendance" | "bids" | "manual" | "browse" | "settings";

function App() {
  const [tab, setTab] = useState<Tab>("attendance");
  const [logPath, setLogPath] = useState("");
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState("");

  // Refreshed whenever Settings changes it — see SettingsPanel's onLogPathChange.
  useEffect(() => {
    GetLogPath().then((p) => p && setLogPath(p));
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
          <div className="log-status">{logPath ? logPath : "No log file selected — see Settings"}</div>
        </div>
        <div className="main">
          {tab === "attendance" && <AttendancePanel />}
          {tab === "bids" && <BidsPanel />}
          {tab === "manual" && <ManualEntryPanel />}
          {tab === "browse" && <BrowsePanel />}
          {tab === "settings" && <SettingsPanel onLogPathChange={setLogPath} />}
        </div>
      </div>
    </div>
  );
}

export default App;
