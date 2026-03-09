interface Props {
  severity?: string;
}

export function SeverityBadge({ severity = "critical" }: Props) {
  return <div className="severity-badge">{severity}</div>;
}
