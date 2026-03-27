import { useState, useEffect } from "react";
import { useTranslation, Trans } from "react-i18next";
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
  const { t } = useTranslation();
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
        <h1 style={headingStyle}>{t("setup.title")}</h1>
        <p style={bodyStyle}>
          {t("setup.tokenGenerated")}
        </p>
        <div style={tokenBoxStyle}>
          <p style={tokenTextStyle}>{token}</p>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button onClick={handleCopy} style={secondaryBtnStyle}>
            {copied ? t("setup.copied") : t("setup.copy")}
          </button>
          <button onClick={onSave} style={primaryBtnStyle}>
            {t("setup.saveAndContinue")}
          </button>
        </div>
        <p style={footerStyle}>
          <Trans i18nKey="setup.recoverFooter" components={{ code: <code style={{ fontFamily: "var(--mono)" }} /> }} />
        </p>
      </div>
    </div>
  );
}

/** Recovery: setup already complete but no token in localStorage. User must enter token manually. */
function TokenRecoveryView({ onSave }: { onSave: (token: string) => void }) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (trimmed) onSave(trimmed);
  };

  return (
    <div style={cardStyle}>
      <div style={panelStyle}>
        <h1 style={headingStyle}>{t("setup.enterToken")}</h1>
        <p style={bodyStyle}>
          <Trans i18nKey="setup.enterTokenBody" components={{ code: <code style={{ fontFamily: "var(--mono)" }} /> }} />
        </p>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("setup.tokenPlaceholder")}
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
            {t("setup.saveAndContinueShort")}
          </button>
        </form>
      </div>
    </div>
  );
}

export function SetupGate({ children }: SetupGateProps) {
  const { t } = useTranslation();
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
          return fetchSetupToken()
            .then((t) => {
              setToken(t);
              setState("first-setup");
            })
            .catch((tokenErr: unknown) => {
              const tokenMsg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
              // 404 on setup-token means dev mode (ALLOW_INSECURE_DEV_MODE) —
              // no token was generated, auth is disabled, proceed without token.
              if (tokenMsg.includes("setup-token 404")) {
                setState("ready");
              } else {
                setErrorMsg(tokenMsg);
                setState("error");
              }
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
        <span style={{ fontFamily: "var(--font)", color: "var(--ink-3)", fontSize: "var(--fs-sm)" }}>{t("common.loading")}</span>
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
          <h1 style={{ ...headingStyle, color: "var(--accent)" }}>{t("setup.failed")}</h1>
          <p style={bodyStyle}>
            {t("setup.failedBody")}
          </p>
          {errorMsg && (
            <div style={tokenBoxStyle}>
              <p style={{ ...tokenTextStyle, color: "var(--accent)" }}>{errorMsg}</p>
            </div>
          )}
          <button onClick={runSetup} style={primaryBtnStyle}>
            {t("setup.retry")}
          </button>
          <p style={footerStyle}>
            <Trans i18nKey="setup.failedFooter" components={{ code: <code style={{ fontFamily: "var(--mono)" }} /> }} />
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
