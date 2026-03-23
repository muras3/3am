import type { CuratedState } from "../../../api/curated-types.js";
import { sectionFallback } from "./board-state.js";

interface Props {
  hypothesis: string;
  state: CuratedState;
}

export function RootCauseHypothesis({ hypothesis, state }: Props) {
  return (
    <div className="lens-board-root-cause">
      <h2 className="lens-board-section-label">Root Cause Hypothesis</h2>
      <p className="lens-board-root-cause-text">
        {hypothesis.trim() || sectionFallback(state, "rootCause")}
      </p>
    </div>
  );
}
