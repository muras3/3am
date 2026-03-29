import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n/index.js";
import { setPreferredLocale } from "../../i18n/index.js";
import type { LensLevel } from "../../routes/__root.js";
import { formatShortIncidentId } from "../../lib/incidentId.js";

interface LevelHeaderProps {
  level: LensLevel;
  incidentId?: string | undefined;
  severity?: string | undefined;
  openedAt?: string | undefined;
  zoomTo: (level: LensLevel, trigger?: HTMLElement, incidentId?: string) => void;
}

function PreferencesMenu() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<"en" | "ja" | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const currentLocale = i18n.language === "ja" ? "ja" : "en";

  useEffect(() => {
    function handlePointer(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  async function handleChange(locale: "en" | "ja") {
    if (locale === currentLocale) return;
    setSaving(locale);
    await setPreferredLocale(locale);
    setSaving(null);
    setOpen(false);
  }

  return (
    <div className="level-header-prefs" ref={wrapperRef}>
      <button
        type="button"
        className="level-header-prefs-btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        {t("preferences.button")}
      </button>
      {open && (
        <div className="level-header-prefs-panel" role="dialog" aria-label={t("preferences.title")}>
          <div className="level-header-prefs-title">{t("preferences.title")}</div>
          <div className="level-header-prefs-copy">{t("preferences.copy")}</div>
          <div className="level-header-prefs-options">
            <button
              type="button"
              className={`level-header-prefs-option${currentLocale === "en" ? " active" : ""}`}
              aria-pressed={currentLocale === "en"}
              disabled={saving !== null}
              onClick={() => void handleChange("en")}
            >
              <span className="level-header-prefs-option-label">{t("preferences.englishLabel")}</span>
              <span className="level-header-prefs-option-detail">{t("preferences.englishDetail")}</span>
            </button>
            <button
              type="button"
              className={`level-header-prefs-option${currentLocale === "ja" ? " active" : ""}`}
              aria-pressed={currentLocale === "ja"}
              disabled={saving !== null}
              onClick={() => void handleChange("ja")}
            >
              <span className="level-header-prefs-option-label">{t("preferences.japaneseLabel")}</span>
              <span className="level-header-prefs-option-detail">{t("preferences.japaneseDetail")}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * LevelHeader — level-aware header bar.
 *
 * - Level 0 (Map): logo + env tag + clock
 * - Level 1 (Incident): back + incident ID + severity + duration + clock
 * - Level 2 (Evidence): back + "Evidence Studio" + severity + clock
 */
export function LevelHeader({
  level,
  incidentId,
  severity,
  openedAt,
  zoomTo,
}: LevelHeaderProps) {
  const { t } = useTranslation();
  const clock = useClock();

  if (level === 0) {
    return (
      <header className="level-header">
        <div className="topbar-logo">
          <span className="pulse" />
          {t("header.logo")}
        </div>
        <span className="topbar-sep" />
        <span className="env-tag">{t("header.env")}</span>
        <PreferencesMenu />
        <span className="level-header-clock">{clock}</span>
      </header>
    );
  }

  if (level === 1) {
    return (
      <header className="level-header">
        <button
          className="back-btn"
          onClick={(e) => zoomTo(0, e.currentTarget)}
          aria-label={t("header.backToMap")}
        >
          {t("header.backToMapLabel")}
        </button>
        <span className="topbar-sep" />
        {incidentId && (
          <span className="level-header-id">{formatShortIncidentId(incidentId)}</span>
        )}
        {severity && (
          <span className="severity-badge" data-severity={severity}>
            {severity}
          </span>
        )}
        {openedAt && <Duration openedAt={openedAt} />}
        <PreferencesMenu />
        <span className="level-header-clock">{clock}</span>
      </header>
    );
  }

  // Level 2
  return (
    <header className="level-header">
      <button
        className="back-btn"
        onClick={(e) => zoomTo(1, e.currentTarget)}
        aria-label={t("header.backToIncident")}
      >
        {incidentId
          ? t("header.backToIncidentLabel", { id: formatShortIncidentId(incidentId) })
          : t("header.backToIncidentFallback")}
      </button>
      <span className="topbar-sep" />
      <span className="level-header-title">{t("header.evidenceStudio")}</span>
      {severity && (
        <span className="severity-badge" data-severity={severity}>
          {severity}
        </span>
      )}
      <PreferencesMenu />
      <span className="level-header-clock">{clock}</span>
    </header>
  );
}

// ── Clock ─────────────────────────────────────────────────────

function useClock(): string {
  const [now, setNow] = useState(() => formatTime(new Date()));
  useEffect(() => {
    const id = setInterval(() => setNow(formatTime(new Date())), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function formatTime(d: Date): string {
  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  const parts = formatter.formatToParts(d);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const second = parts.find((part) => part.type === "second")?.value;
  const timeZoneName = parts.find((part) => part.type === "timeZoneName")?.value;

  if (hour && minute && second && timeZoneName) {
    return `${hour}:${minute}:${second} ${timeZoneName}`;
  }

  return formatter.format(d);
}

// ── Duration ──────────────────────────────────────────────────

function Duration({ openedAt }: { openedAt: string }) {
  const [text, setText] = useState(() => formatDuration(openedAt));
  useEffect(() => {
    const id = setInterval(() => setText(formatDuration(openedAt)), 1000);
    return () => clearInterval(id);
  }, [openedAt]);

  return <span className="level-header-duration">{text}</span>;
}

export function formatDuration(openedAt: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(openedAt).getTime());
  const s = Math.floor(elapsed / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return i18n.t("header.durationHours", { hours: h, minutes: m % 60 });
  return i18n.t("header.duration", { minutes: m, seconds: s % 60 });
}
