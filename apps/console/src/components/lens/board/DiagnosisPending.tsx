interface Props {
  message?: string;
  subtext?: string;
}

export function DiagnosisPending({ message, subtext }: Props) {
  return (
    <div className="lens-board-pending" role="status" aria-live="polite">
      <div className="lens-board-pending-pulse" aria-hidden="true" />
      <p className="lens-board-pending-text">{message ?? "Diagnosis in progress…"}</p>
      <p className="lens-board-pending-sub">
        {subtext ?? "The LLM is analysing the incident. This usually takes under a minute."}
      </p>
    </div>
  );
}
