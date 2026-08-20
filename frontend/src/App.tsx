import { useEffect, useState } from "react";
import "./App.css";
import { GetLogPath, SelectLogFile } from "../wailsjs/go/main/App";
import { AttendancePanel } from "./AttendancePanel";
import { BidsPanel } from "./BidsPanel";
import { SettingsPanel } from "./SettingsPanel";

type Tab = "attendance" | "bids" | "settings";

function App() {
  const [tab, setTab] = useState<Tab>("attendance");
  const [logPath, setLogPath] = useState("");

  async function onPickLogFile() {
    const path = await SelectLogFile();
    if (path) setLogPath(path);
  }

  // Pick up whatever was already selected before this component mounted,
  // so the status line at the bottom of the sidebar never lies about
  // what's active.
  useEffect(() => {
    GetLogPath().then((p) => p && setLogPath(p));
  }, []);

  return (
    <div className="app">
      <div className="sidebar">
        <h1>Seekers EPGP</h1>
        <button className={`nav-button ${tab === "attendance" ? "active" : ""}`} onClick={() => setTab("attendance")}>
          Attendance
        </button>
        <button className={`nav-button ${tab === "bids" ? "active" : ""}`} onClick={() => setTab("bids")}>
          Bids
        </button>
        <button className={`nav-button ${tab === "settings" ? "active" : ""}`} onClick={() => setTab("settings")}>
          Settings
        </button>
        <div style={{ marginTop: 16 }}>
          <button className="secondary" onClick={onPickLogFile} style={{ width: "100%" }}>
            Select Log File
          </button>
        </div>
        <div className="log-status">{logPath ? logPath : "No log file selected"}</div>
      </div>
      <div className="main">
        {tab === "attendance" && <AttendancePanel />}
        {tab === "bids" && <BidsPanel />}
        {tab === "settings" && <SettingsPanel />}
      </div>
    </div>
  );
}

export default App;
