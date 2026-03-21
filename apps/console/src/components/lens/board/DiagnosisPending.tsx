export function DiagnosisPending() {
  return (
    <div className="lens-board-pending" role="status" aria-live="polite">
      <div className="lens-board-pending-pulse" aria-hidden="true" />
      <p className="lens-board-pending-text">Diagnosis in progress…</p>
      <p className="lens-board-pending-sub">
        The LLM is analysing the incident. This usually takes under a minute.
      </p>
    </div>
  );
}
