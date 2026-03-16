import type { SideNoteVM, SpanDetailVM, TabKey } from "../../lib/viewmodels/index.js";

interface Props {
  notes: SideNoteVM[];
  detailCard: SpanDetailVM | null;
  activeTab: TabKey;
}

function accentClass(accent: SideNoteVM["accent"]): string {
  if (accent === "teal") return "note-card-teal";
  if (accent === "accent") return "note-card-accent";
  return "";
}

function httpStatusColor(code: number | undefined): string {
  if (!code) return "var(--ink-2)";
  if (code >= 500) return "var(--accent-text)";
  if (code >= 400) return "var(--amber)";
  return "var(--good)";
}

function spanStatusLabel(code: number): string {
  if (code === 2) return "ERROR";
  if (code === 1) return "OK";
  return "UNSET";
}

function durationBarWidth(ms: number): string {
  // Map 0-10000ms to 0-100% for mini bar
  const pct = Math.min(100, (ms / 10000) * 100);
  return `${pct.toFixed(1)}%`;
}

function durationBarColor(ms: number): string {
  if (ms > 5000) return "var(--accent)";
  if (ms > 2000) return "var(--amber)";
  return "var(--teal)";
}

export function SideRail({ notes, detailCard, activeTab: _activeTab }: Props) {
  return (
    <div className="es-side">
      {detailCard && (
        <div className="note-card note-card-teal" data-testid="span-detail-card">
          <div className="note-card-title">Span Detail</div>
          {detailCard.isAiSelected && (
            <div className="sd-ai-line">AI selected for diagnosis</div>
          )}
          <div className="sd-fields">
            <div className="sd-field">
              <span className="sd-key">span_id</span>
              <span className="sd-val" title={detailCard.spanId}>
                {detailCard.spanId.slice(0, 12)}…
              </span>
            </div>
            {detailCard.spanName && (
              <div className="sd-field">
                <span className="sd-key">name</span>
                <span className="sd-val">{detailCard.spanName}</span>
              </div>
            )}
            <div className="sd-field">
              <span className="sd-key">service</span>
              <span className="sd-val">{detailCard.serviceName}</span>
            </div>
            {detailCard.httpRoute && (
              <div className="sd-field">
                <span className="sd-key">route</span>
                <span className="sd-val">{detailCard.httpRoute}</span>
              </div>
            )}
            {detailCard.httpMethod && (
              <div className="sd-field">
                <span className="sd-key">method</span>
                <span className="sd-val">{detailCard.httpMethod}</span>
              </div>
            )}
            <div className="sd-field">
              <span className="sd-key">duration</span>
              <span className="sd-val">{detailCard.durationMs}ms</span>
            </div>
            <div
              className="sd-bar-mini"
              style={{ background: "var(--panel-3)", width: "100%" }}
            >
              <div
                className="sd-bar-fill"
                style={{
                  width: durationBarWidth(detailCard.durationMs),
                  background: durationBarColor(detailCard.durationMs),
                }}
              />
            </div>
            {detailCard.httpStatusCode != null && (
              <div className="sd-field">
                <span className="sd-key">http_status</span>
                <span
                  className="sd-val"
                  style={{ color: httpStatusColor(detailCard.httpStatusCode) }}
                >
                  {detailCard.httpStatusCode}
                </span>
              </div>
            )}
            <div className="sd-field">
              <span className="sd-key">span_status</span>
              <span className="sd-val">{spanStatusLabel(detailCard.spanStatusCode)}</span>
            </div>
            {detailCard.spanKind != null && (
              <div className="sd-field">
                <span className="sd-key">kind</span>
                <span className="sd-val">{detailCard.spanKind}</span>
              </div>
            )}
            {detailCard.peerService && (
              <div className="sd-field">
                <span className="sd-key">peer</span>
                <span className="sd-val">{detailCard.peerService}</span>
              </div>
            )}
            {detailCard.exceptionCount > 0 && (
              <div className="sd-field">
                <span className="sd-key">exceptions</span>
                <span className="sd-val" style={{ color: "var(--accent-text)" }}>
                  {detailCard.exceptionCount}
                </span>
              </div>
            )}
            {detailCard.parentSpanId && (
              <div className="sd-field">
                <span className="sd-key">parent_id</span>
                <span className="sd-val" title={detailCard.parentSpanId}>
                  {detailCard.parentSpanId.slice(0, 10)}…
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {notes.map((note, i) => (
        <div
          key={i}
          className={`note-card ${accentClass(note.accent)}`}
          data-testid="note-card"
        >
          <div className="note-card-title">{note.title}</div>
          <div className="note-card-text">{note.text}</div>
        </div>
      ))}
    </div>
  );
}
