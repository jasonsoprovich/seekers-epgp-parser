import { useEffect, useState } from "react";
import { GetLogPath, GetSettings, OpenAppKeyPage, SaveSettings, SelectLogFile, TestConnection } from "../wailsjs/go/main/App";

export function SettingsPanel({ onLogPathChange }: { onLogPathChange: (path: string) => void }) {
  const [apiKey, setApiKey] = useState("");
  const [logPath, setLogPath] = useState("");
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    GetSettings().then((s) => setApiKey(s.apiKey));
    GetLogPath().then(setLogPath);
  }, []);

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
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <button className="secondary" onClick={() => OpenAppKeyPage()} style={{ alignSelf: "flex-start" }}>
          Generate an API Key on the site ↗
        </button>
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
    </div>
  );
}
