import { useEffect, useState } from "react";
import "./App.css";
import { GetLogPath } from "../wailsjs/go/main/App";
import { AttendancePanel } from "./AttendancePanel";
import { BidsPanel } from "./BidsPanel";
import { SettingsPanel } from "./SettingsPanel";

type Tab = "attendance" | "bids" | "settings";

function App() {
  const [tab, setTab] = useState<Tab>("attendance");
  const [logPath, setLogPath] = useState("");

  // Refreshed whenever Settings changes it — see SettingsPanel's onLogPathChange.
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
        <div className="log-status">{logPath ? logPath : "No log file selected — see Settings"}</div>
      </div>
      <div className="main">
        {tab === "attendance" && <AttendancePanel />}
        {tab === "bids" && <BidsPanel />}
        {tab === "settings" && <SettingsPanel onLogPathChange={setLogPath} />}
      </div>
    </div>
  );
}

export default App;
