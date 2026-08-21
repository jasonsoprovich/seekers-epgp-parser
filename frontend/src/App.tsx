import { useEffect, useState } from "react";
import "./App.css";
import { CheckForUpdate, GetLogPath, OpenReleasePage } from "../wailsjs/go/main/App";
import { updatecheck } from "../wailsjs/go/models";
import { AttendancePanel } from "./AttendancePanel";
import { BidsPanel } from "./BidsPanel";
import { BrowsePanel } from "./BrowsePanel";
import { ManualEntryPanel } from "./ManualEntryPanel";
import { SettingsPanel } from "./SettingsPanel";

type Tab = "attendance" | "bids" | "manual" | "browse" | "settings";

function App() {
  const [tab, setTab] = useState<Tab>("attendance");
  const [logPath, setLogPath] = useState("");
  const [updateInfo, setUpdateInfo] = useState<updatecheck.Info | null>(null);

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

  return (
    <div className="app">
      {updateInfo && (
        <div className="update-banner">
          A new version ({updateInfo.latest}) is available — you're on {updateInfo.current}.
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
