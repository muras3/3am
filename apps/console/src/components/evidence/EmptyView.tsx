interface Props {
  label: string;
}

export function EmptyView({ label }: Props) {
  return (
    <div
      style={{
        padding: "32px 20px",
        textAlign: "center",
        color: "var(--ink-3)",
        fontSize: "12px",
      }}
    >
      No {label} data available for this incident.
    </div>
  );
}
