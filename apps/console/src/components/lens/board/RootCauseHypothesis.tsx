interface Props {
  hypothesis: string;
}

export function RootCauseHypothesis({ hypothesis }: Props) {
  return (
    <div className="lens-board-root-cause">
      <h2 className="lens-board-section-label">Root Cause Hypothesis</h2>
      <p className="lens-board-root-cause-text">{hypothesis}</p>
    </div>
  );
}
