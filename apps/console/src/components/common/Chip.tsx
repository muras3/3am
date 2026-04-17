interface Props {
  label: string;
  variant?: "critical" | "system" | "external" | "default";
}

export function Chip({ label, variant = "default" }: Props) {
  const cls = variant === "default" ? "chip" : `chip chip-${variant}`;
  return <div className={cls}>{label}</div>;
}
