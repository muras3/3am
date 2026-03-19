import { useState, useEffect } from "react";
import { saveAuthToken, getStoredAuthToken } from "../api/client.js";

interface SetupStatus {
  setupComplete: boolean;
}

interface SetupTokenResponse {
  token: string;
}

async function fetchSetupStatus(): Promise<SetupStatus> {
  const res = await fetch("/api/setup-status");
  if (!res.ok) throw new Error(`setup-status ${res.status}`);
  return res.json() as Promise<SetupStatus>;
}

async function fetchSetupToken(): Promise<string> {
  const res = await fetch("/api/setup-token");
  if (!res.ok) throw new Error(`setup-token ${res.status}`);
  const data = (await res.json()) as SetupTokenResponse;
  return data.token;
}

interface SetupGateProps {
  children: React.ReactNode;
}

export function SetupGate({ children }: SetupGateProps) {
  const [state, setState] = useState<"loading" | "setup" | "ready" | "error">("loading");
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // If token already in localStorage, skip setup
    if (getStoredAuthToken()) {
      setState("ready");
      return;
    }

    fetchSetupStatus()
      .then((status) => {
        if (status.setupComplete) {
          // Setup done but no token in localStorage — user cleared storage or different browser
          setState("ready");
        } else {
          // First time — fetch and show the token
          return fetchSetupToken().then((t) => {
            setToken(t);
            setState("setup");
          });
        }
      })
      .catch(() => {
        // If setup-status fails, assume dev mode (no auth) and proceed
        setState("ready");
      });
  }, []);

  if (state === "loading") {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--bg)" }}>
        <span style={{ fontFamily: "var(--font)", color: "var(--ink-3)", fontSize: "var(--fs-sm)" }}>Loading...</span>
      </div>
    );
  }

  if (state === "setup" && token) {
    const handleSave = () => {
      saveAuthToken(token);
      setState("ready");
    };

    const handleCopy = () => {
      void navigator.clipboard.writeText(token).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    };

    return (
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        background: "var(--bg)",
        padding: "24px",
      }}>
        <div style={{
          background: "var(--panel)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius)",
          padding: "32px",
          maxWidth: "480px",
          width: "100%",
        }}>
          <h1 style={{
            fontFamily: "var(--font)",
            fontSize: "var(--fs-lg)",
            fontWeight: 600,
            color: "var(--ink)",
            margin: "0 0 8px",
          }}>
            3amoncall Setup
          </h1>
          <p style={{
            fontFamily: "var(--font)",
            fontSize: "var(--fs-sm)",
            color: "var(--ink-2)",
            margin: "0 0 24px",
            lineHeight: 1.5,
          }}>
            Your auth token has been generated. Save it now — it will not be shown again.
          </p>

          <div style={{
            background: "var(--panel-2)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-sm)",
            padding: "12px",
            marginBottom: "16px",
          }}>
            <p style={{
              fontFamily: "var(--mono)",
              fontSize: "var(--fs-sm)",
              color: "var(--ink)",
              margin: 0,
              wordBreak: "break-all",
              userSelect: "all",
            }}>
              {token}
            </p>
          </div>

          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={handleCopy}
              style={{
                fontFamily: "var(--font)",
                fontSize: "var(--fs-sm)",
                color: "var(--ink-2)",
                background: "var(--panel-2)",
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-sm)",
                padding: "6px 12px",
                cursor: "pointer",
                flex: "0 0 auto",
              }}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              onClick={handleSave}
              style={{
                fontFamily: "var(--font)",
                fontSize: "var(--fs-sm)",
                color: "#fff",
                background: "var(--accent)",
                border: "none",
                borderRadius: "var(--radius-sm)",
                padding: "6px 16px",
                cursor: "pointer",
                flex: 1,
                fontWeight: 600,
              }}
            >
              I have saved this token — Continue
            </button>
          </div>

          <p style={{
            fontFamily: "var(--font)",
            fontSize: "var(--fs-xs)",
            color: "var(--ink-3)",
            margin: "12px 0 0",
          }}>
            To recover a lost token, set <code style={{ fontFamily: "var(--mono)" }}>RECEIVER_AUTH_TOKEN</code> in your Vercel environment variables.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
