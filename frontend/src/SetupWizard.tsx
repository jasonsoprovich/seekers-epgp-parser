import { useEffect, useState } from "react";
import {
  DetectedLogs,
  OpenAppKeyPage,
  SaveSettings,
  SelectGameDir,
  SetSetupComplete,
  TestConnection,
} from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/app";
import type { GameDirInfo } from "../bindings/github.com/jasonsoprovich/seekers-epgp-parser/models";
import { invalidateRoster } from "./useRoster";

// First-run wizard (2026-09-09 sim feedback). Shows over everything until
// the officer has pointed the app at their EQ folder, pasted an API key,
// and confirmed the connection — or explicitly skipped. `SetSetupComplete`
// persists the "don't show this again" flag; Settings has a button to
// reopen it. Deliberately not blocking forever — "Skip for now" lets an
// officer who knows what they're doing get straight to Settings.
export function SetupWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [gameDir, setGameDir] = useState<GameDirInfo | null>(null);
  const [gameDirError, setGameDirError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testMsg, setTestMsg] = useState("");

  useEffect(() => {
    DetectedLogs()
      .then((info) => setGameDir(info.gameDir ? info : null))
      .catch(() => {});
  }, []);

  async function finish() {
    try {
      await SetSetupComplete(true);
    } catch {
      // non-fatal — worst case the wizard shows again next launch
    }
    onDone();
  }

  async function pickGameDir() {
    setGameDirError(null);
    try {
      const info = await SelectGameDir();
      setGameDir(info.gameDir ? info : null);
    } catch (err) {
      setGameDirError(String(err));
    }
  }

  async function saveKeyAndNext() {
    try {
      await SaveSettings(apiKey.trim());
      invalidateRoster();
    } catch {
      // SaveSettings only writes a file; a failure here is unusual and the
      // Verify step will surface any real problem.
    }
    setStep(2);
    void runTest();
  }

  async function runTest() {
    setTestState("testing");
    setTestMsg("");
    try {
      const count = await TestConnection();
      setTestState("ok");
      setTestMsg(`Connected — pulled ${count} character${count === 1 ? "" : "s"} from the roster.`);
    } catch (err) {
      setTestState("fail");
      setTestMsg(String(err));
    }
  }

  const activeChar = gameDir?.logs?.find((l) => l.path === gameDir.activePath);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
        padding: 24,
      }}
    >
      <div
        style={{
          background: "#131a26",
          border: "1px solid #2a3550",
          borderRadius: 12,
          padding: 28,
          width: "min(560px, 100%)",
          boxShadow: "0 16px 50px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Set up Seekers EPGP</h2>
          <span style={{ color: "#6b7280", fontSize: 12 }}>Step {step + 1} of 3</span>
        </div>
        <div style={{ display: "flex", gap: 4, marginBottom: 18 }}>
          {[0, 1, 2].map((n) => (
            <div key={n} style={{ height: 3, flex: 1, borderRadius: 2, background: n <= step ? "#10b981" : "#2a3550" }} />
          ))}
        </div>

        {step === 0 && (
          <div>
            <p style={{ marginTop: 0, fontSize: 13, color: "#d1d5db", lineHeight: 1.5 }}>
              Point the app at your EverQuest folder (or its <code>Logs</code> folder). It follows whichever character
              you&apos;re playing, so you never re-pick when you swap to an alt for a raid.
            </p>
            <button className="primary" onClick={pickGameDir}>
              Select EverQuest Folder
            </button>
            {gameDir && (
              <p style={{ fontSize: 13, marginBottom: 0 }}>
                <span style={{ color: "#9ca3af", wordBreak: "break-all" }}>{gameDir.gameDir}</span>
                <br />
                {activeChar ? (
                  <span style={{ color: "#10b981" }}>
                    ✓ Watching <strong>{activeChar.character}</strong> ({activeChar.server})
                  </span>
                ) : (
                  <span style={{ color: "#fbbf24" }}>Folder set — no character log written yet. Log in and it&apos;ll pick it up.</span>
                )}
              </p>
            )}
            {gameDirError && <div className="error">{gameDirError}</div>}
          </div>
        )}

        {step === 1 && (
          <div>
            <p style={{ marginTop: 0, fontSize: 13, color: "#d1d5db", lineHeight: 1.5 }}>
              Generate an app key on the site (you&apos;ll need to be signed in as an officer), then paste it here.
            </p>
            <button className="secondary" onClick={() => OpenAppKeyPage()} style={{ marginBottom: 10 }}>
              Open the key page ↗
            </button>
            <input
              type="password"
              placeholder="Paste your API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              style={{ width: "100%" }}
            />
          </div>
        )}

        {step === 2 && (
          <div>
            <p style={{ marginTop: 0, fontSize: 13, color: "#d1d5db" }}>Checking the key against the site…</p>
            {testState === "testing" && <div style={{ color: "#9ca3af", fontSize: 13 }}>Testing…</div>}
            {testState === "ok" && <div className="success">{testMsg}</div>}
            {testState === "fail" && (
              <div className="error">
                Couldn&apos;t connect: {testMsg}
                <div style={{ marginTop: 8 }}>
                  <button className="secondary" onClick={() => setStep(1)}>
                    Back to the key
                  </button>{" "}
                  <button className="secondary" onClick={() => void runTest()}>
                    Retry
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24 }}>
          <button
            className="secondary"
            onClick={() => void finish()}
            style={{ border: "none", color: "#6b7280", padding: 0 }}
          >
            Skip for now
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            {step > 0 && (
              <button className="secondary" onClick={() => setStep((s) => Math.max(0, s - 1))}>
                Back
              </button>
            )}
            {step === 0 && (
              <button className="primary" onClick={() => setStep(1)} disabled={!gameDir}>
                Next
              </button>
            )}
            {step === 1 && (
              <button className="primary" onClick={() => void saveKeyAndNext()} disabled={!apiKey.trim()}>
                Next
              </button>
            )}
            {step === 2 && (
              <button className="primary" onClick={() => void finish()}>
                {testState === "ok" ? "Finish" : "Finish anyway"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
