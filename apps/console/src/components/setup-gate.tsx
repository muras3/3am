import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AUTH_FAILURE_EVENT, getStoredAuthToken } from "../api/client.js";

interface SetupGateProps {
  children: React.ReactNode;
}

const cardStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "100vh",
  background: "var(--bg)",
  padding: "24px",
};

const panelStyle: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius)",
  padding: "32px",
  maxWidth: "520px",
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
  margin: "0 0 18px",
  lineHeight: 1.55,
};

const footerStyle: React.CSSProperties = {
  fontFamily: "var(--font)",
  fontSize: "var(--fs-xs)",
  color: "var(--ink-3)",
  margin: "12px 0 0",
  lineHeight: 1.5,
};

const primaryButtonStyle: React.CSSProperties = {
  fontFamily: "var(--font)",
  fontSize: "var(--fs-sm)",
  color: "#fff",
  background: "var(--accent)",
  border: "none",
  borderRadius: "var(--radius)",
  padding: "8px 16px",
  cursor: "pointer",
  fontWeight: 600,
};

const errorBoxStyle: React.CSSProperties = {
  background: "var(--panel-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius-sm)",
  padding: "12px",
  marginBottom: "16px",
  fontFamily: "var(--mono)",
  fontSize: "var(--fs-xs)",
  color: "var(--accent)",
  overflowWrap: "anywhere",
};

function getClaimTokenFromHash(): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith("#")) return null;
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get("claim");
  return token && token.trim().length > 0 ? token.trim() : null;
}

function clearClaimTokenFromHash(): void {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  params.delete("claim");
  const nextHash = params.toString();
  url.hash = nextHash ? `#${nextHash}` : "";
  window.history.replaceState({}, document.title, url.toString());
}

async function exchangeClaimToken(token: string): Promise<void> {
  const res = await fetch("/api/claims/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`claim-exchange ${res.status}`);
}

async function probeAuthenticatedSession(): Promise<"active" | "claim-required"> {
  const res = await fetch("/api/settings/diagnosis");
  if (res.ok) return "active";
  if (res.status === 401 || res.status === 403) return "claim-required";
  throw new Error(`session-probe ${res.status}`);
}

function ClaimRequiredView({
  onRetry,
}: {
  onRetry: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div style={cardStyle}>
      <div style={panelStyle}>
        <h1 style={headingStyle}>{t("setup.claimTitle")}</h1>
        <p style={bodyStyle}>{t("setup.claimBody")}</p>
        <button type="button" onClick={onRetry} style={primaryButtonStyle}>
          {t("setup.retry")}
        </button>
        <p style={footerStyle}>
          <Trans
            i18nKey="setup.claimFooter"
            components={{ code: <code style={{ fontFamily: "var(--mono)" }} /> }}
          />
        </p>
      </div>
    </div>
  );
}

export function SetupGate({ children }: SetupGateProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<"loading" | "claim-required" | "error" | "ready">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  const runSetup = () => {
    setState("loading");
    setErrorMsg("");

    // Backward-compatible path for existing browser sessions that still rely on localStorage.
    if (getStoredAuthToken()) {
      setState("ready");
      return;
    }

    const claimToken = getClaimTokenFromHash();
    if (claimToken) {
      exchangeClaimToken(claimToken)
        .then(() => {
          clearClaimTokenFromHash();
          setState("ready");
        })
        .catch((err: unknown) => {
          setErrorMsg(err instanceof Error ? err.message : String(err));
          setState("error");
        });
      return;
    }

    probeAuthenticatedSession()
      .then((status) => {
        setState(status === "active" ? "ready" : "claim-required");
      })
      .catch((err: unknown) => {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setState("error");
      });
  };

  useEffect(() => {
    runSetup();
  }, []);

  useEffect(() => {
    const onAuthFailure = () => setState("claim-required");
    window.addEventListener(AUTH_FAILURE_EVENT, onAuthFailure);
    return () => window.removeEventListener(AUTH_FAILURE_EVENT, onAuthFailure);
  }, []);

  if (state === "loading") {
    return (
      <div style={cardStyle}>
        <span style={{ fontFamily: "var(--font)", color: "var(--ink-3)", fontSize: "var(--fs-sm)" }}>
          {t("common.loading")}
        </span>
      </div>
    );
  }

  if (state === "claim-required") {
    return <ClaimRequiredView onRetry={runSetup} />;
  }

  if (state === "error") {
    return (
      <div style={cardStyle}>
        <div style={panelStyle}>
          <h1 style={{ ...headingStyle, color: "var(--accent)" }}>{t("setup.failed")}</h1>
          <p style={bodyStyle}>{t("setup.failedBody")}</p>
          {errorMsg ? <div style={errorBoxStyle}>{errorMsg}</div> : null}
          <button type="button" onClick={runSetup} style={primaryButtonStyle}>
            {t("setup.retry")}
          </button>
          <p style={footerStyle}>
            <Trans
              i18nKey="setup.failedFooter"
              components={{ code: <code style={{ fontFamily: "var(--mono)" }} /> }}
            />
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
