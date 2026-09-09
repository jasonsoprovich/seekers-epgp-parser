import { useEffect, useRef, type ReactNode } from "react";

// A small yes/no confirmation used before the two irreversible-ish writes
// in the app — submitting attendance and submitting a bid round to the
// site. Deliberately not a browser `confirm()` (blocks the Wails webview
// event loop) and not the native `<dialog>` element (its backdrop/close
// behaviour is inconsistent across the WebView2/WKWebView builds the app
// ships on). Just a fixed overlay + focus-trapped panel.
export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      onClick={() => !busy && onCancel()}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#131a26",
          border: "1px solid #2a3550",
          borderRadius: 10,
          padding: 20,
          maxWidth: 460,
          width: "calc(100% - 48px)",
          boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
        }}
      >
        <h3 style={{ margin: "0 0 10px", fontSize: 16 }}>{title}</h3>
        <div style={{ fontSize: 13, color: "#d1d5db", lineHeight: 1.5 }}>{body}</div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button className="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button className="primary" ref={confirmRef} onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
