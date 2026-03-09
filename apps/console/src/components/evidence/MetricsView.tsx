import type { Incident } from "../../api/types.js";

interface Props {
  incident: Incident;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function MetricsView({ incident }: Props) {
  return (
    <div className="ev-empty-metrics" style={{ padding: "24px 20px" }}>
      <div
        style={{
          width: "100%",
          height: "120px",
          border: "1.5px dashed var(--line-strong)",
          borderRadius: "var(--radius)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--ink-3)",
          fontSize: "12px",
          marginBottom: "12px",
          background: "var(--panel-2)",
        }}
      >
        <svg
          width="48"
          height="32"
          viewBox="0 0 48 32"
          fill="none"
          style={{ opacity: 0.35 }}
        >
          <polyline
            points="0,28 8,20 16,24 24,10 32,16 40,6 48,12"
            stroke="currentColor"
            strokeWidth="2"
            fill="none"
          />
        </svg>
      </div>
      <div
        style={{
          fontSize: "12px",
          color: "var(--ink-3)",
          textAlign: "center",
        }}
      >
        No metrics data — will appear when /v1/metrics ingest is active
      </div>
    </div>
  );
}
