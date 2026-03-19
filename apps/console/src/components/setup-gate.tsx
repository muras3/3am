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

// Shared card container styles
const cardStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100vh",
  background: "var(--bg)",
  padding: "24px",
};

const panelStyle: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius)",
  padding: "32px",
  maxWidth: "480px",
  width: "100%",
};

const headingStyle: React.CSSProperties = {
  fontFamily: "var(--font)",
  fontSize: "var(--fs-lg)",
  fontWeight: 600,
  color: "var(--ink)",
  margin: "0 0 8px",
};

const bodyStyle: React.CSSProperties = {
  fontFamily: "var(--font)",
  fontSize: "var(--fs-sm)",
  color: "var(--ink-2)",
  margin: "0 0 24px",
  lineHeight: 1.5,
};

const tokenBoxStyle: React.CSSProperties = {
  background: "var(--panel-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius-sm)",
  padding: "12px",
  marginBottom: "16px",
};

const tokenTextStyle: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: "var(--fs-sm)",
  color: "var(--ink)",
  margin: 0,
  wordBreak: "break-all",
  userSelect: "all",
};

const footerStyle: React.CSSProperties = {
  fontFamily: "var(--font)",
  fontSize: "var(--fs-xs)",
  color: "var(--ink-3)",
  margin: "12px 0 0",
};

const secondaryBtnStyle: React.CSSProperties = {
  fontFamily: "var(--font)",
  fontSize: "var(--fs-sm)",
  color: "var(--ink-2)",
  background: "var(--panel-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius-sm)",
  padding: "6px 12px",
  cursor: "pointer",
  flex: "0 0 auto",
};

const primaryBtnStyle: React.CSSProperties = {
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
};

/** First-boot: show generated token, prompt user to save it. */
function FirstSetupView({ token, onSave }: { token: string; onSave: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={cardStyle}>
      <div style={panelStyle}>
        <h1 style={headingStyle}>3amoncall Setup</h1>
        <p style={bodyStyle}>
          Your auth token has been generated. Save it now — it will not be shown again.
        </p>
        <div style={tokenBoxStyle}>
          <p style={tokenTextStyle}>{token}</p>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button onClick={handleCopy} style={secondaryBtnStyle}>
            {copied ? "Copied!" : "Copy"}
          </button>
          <button onClick={onSave} style={primaryBtnStyle}>
            I have saved this token — Continue
          </button>
        </div>
        <p style={footerStyle}>
          To recover a lost token, set{" "}
          <code style={{ fontFamily: "var(--mono)" }}>RECEIVER_AUTH_TOKEN</code>{" "}
          in your Vercel environment variables.
        </p>
      </div>
    </div>
  );
}

/** Recovery: setup already complete but no token in localStorage. User must enter token manually. */
function TokenRecoveryView({ onSave }: { onSave: (token: string) => void }) {
  const [input, setInput] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (trimmed) onSave(trimmed);
  };

  return (
    <div style={cardStyle}>
      <div style={panelStyle}>
        <h1 style={headingStyle}>Enter Auth Token</h1>
        <p style={bodyStyle}>
          Your auth token was previously set up but is not present in this browser. Enter your
          token to continue. You can find it in your Vercel environment variables
          (<code style={{ fontFamily: "var(--mono)" }}>RECEIVER_AUTH_TOKEN</code>) or from when
          you first set up 3amoncall.
        </p>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste your auth token here"
            style={{
              fontFamily: "var(--mono)",
              fontSize: "var(--fs-sm)",
              color: "var(--ink)",
              background: "var(--panel-2)",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-sm)",
              padding: "8px 12px",
              width: "100%",
              boxSizing: "border-box",
              marginBottom: "12px",
              outline: "none",
            }}
          />
          <button
            type="submit"
            disabled={!input.trim()}
            style={{ ...primaryBtnStyle, flex: "none", width: "100%", padding: "8px 16px" }}
          >
            Save and Continue
          </button>
        </form>
      </div>
    </div>
  );
}

export function SetupGate({ children }: SetupGateProps) {
  const [state, setState] = useState<"loading" | "first-setup" | "recovery" | "error" | "ready">("loading");
  const [token, setToken] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");

  const runSetup = () => {
    setState("loading");
    setErrorMsg("");

    // If token already in localStorage, skip setup entirely
    if (getStoredAuthToken()) {
      setState("ready");
      return;
    }

    fetchSetupStatus()
      .then((status) => {
        if (status.setupComplete) {
          // Setup done but no token in localStorage — show recovery input
          setState("recovery");
        } else {
          // First time — fetch and display the generated token
          return fetchSetupToken().then((t) => {
            setToken(t);
            setState("first-setup");
          });
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // 404 on /api/setup-status means the receiver is running with
        // ALLOW_INSECURE_DEV_MODE=true and has no setup endpoint → proceed.
        // All other failures (network error, 500, etc.) show an error UI
        // so the user can retry rather than entering the app with no token.
        if (msg.includes("setup-status 404")) {
          setState("ready");
        } else {
          setErrorMsg(msg);
          setState("error");
        }
      });
  };

  useEffect(() => {
    runSetup();
  }, []);

  if (state === "loading") {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--bg)" }}>
        <span style={{ fontFamily: "var(--font)", color: "var(--ink-3)", fontSize: "var(--fs-sm)" }}>Loading...</span>
      </div>
    );
  }

  if (state === "first-setup" && token) {
    return (
      <FirstSetupView
        token={token}
        onSave={() => {
          saveAuthToken(token);
          setState("ready");
        }}
      />
    );
  }

  if (state === "recovery") {
    return (
      <TokenRecoveryView
        onSave={(t) => {
          saveAuthToken(t);
          setState("ready");
        }}
      />
    );
  }

  if (state === "error") {
    return (
      <div style={cardStyle}>
        <div style={panelStyle}>
          <h1 style={{ ...headingStyle, color: "var(--accent)" }}>Setup Failed</h1>
          <p style={bodyStyle}>
            Could not connect to the receiver to complete setup.
          </p>
          {errorMsg && (
            <div style={tokenBoxStyle}>
              <p style={{ ...tokenTextStyle, color: "var(--accent)" }}>{errorMsg}</p>
            </div>
          )}
          <button onClick={runSetup} style={primaryBtnStyle}>
            Retry
          </button>
          <p style={footerStyle}>
            If this persists, check that the receiver is running and{" "}
            <code style={{ fontFamily: "var(--mono)" }}>RECEIVER_AUTH_TOKEN</code>{" "}
            is set correctly.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
