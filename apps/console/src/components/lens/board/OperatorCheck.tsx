interface Props {
  checks: string[];
}

export function OperatorCheck({ checks }: Props) {
  return (
    <div className="lens-board-card">
      <div className="lens-board-card-title">Operator Check</div>
      <ul className="lens-board-checklist" role="list">
        {checks.map((item, i) => (
          <li key={i} className="lens-board-check-item">
            <label className="lens-board-check-label">
              <input type="checkbox" className="lens-board-checkbox" />
              <span>{item}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
