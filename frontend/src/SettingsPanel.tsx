import { useEffect, useState } from "react";
import { GetSettings, SaveSettings, TestConnection } from "../wailsjs/go/main/App";

export function SettingsPanel() {
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    GetSettings().then((s) => {
      setServerUrl(s.serverUrl);
      setApiKey(s.apiKey);
    });
  }, []);

  async function onSave() {
    setPending(true);
    setSaved(false);
    try {
      await SaveSettings(serverUrl.trim(), apiKey.trim());
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
      await SaveSettings(serverUrl.trim(), apiKey.trim());
      const count = await TestConnection();
      setTestResult(`Connected — pulled ${count} character${count === 1 ? "" : "s"} from the roster.`);
    } catch (err) {
      setTestError(String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div className="panel-header">
        <h2>Settings</h2>
      </div>

      <div className="form-grid">
        <label>
          Server URL
          <input
            type="text"
            placeholder="https://seekers.fetchinglogic.com"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            placeholder="Generate one on the site under Admin → App Key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
      </div>

      <div className="toolbar">
        <button className="primary" onClick={onSave} disabled={pending}>
          {saved ? "Saved" : "Save"}
        </button>
        <button className="secondary" onClick={onTest} disabled={pending || !serverUrl.trim() || !apiKey.trim()}>
          {pending ? "Testing…" : "Test Connection"}
        </button>
      </div>

      {testResult && <div className="success">{testResult}</div>}
      {testError && <div className="error">{testError}</div>}
    </div>
  );
}
