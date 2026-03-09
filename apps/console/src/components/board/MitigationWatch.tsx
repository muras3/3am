import type { DiagnosisResult } from "../../api/types.js";

const STATUS_CLASS: Record<string, string> = {
  watch: "ws-watch",
  ok: "ws-next",
  alert: "ws-lagging",
};

interface Props {
  diagnosisResult: DiagnosisResult;
}

export function MitigationWatch({ diagnosisResult }: Props) {
  const { watch_items } = diagnosisResult.operator_guidance;
  return (
    <div className="bottom-card">
      <div className="card-title">Mitigation Watch</div>
      {watch_items.map((item, i) => (
        <div key={i} className="watch-row">
          <div className="wl">{item.label}</div>
          <div className="wv">{item.state}</div>
          <div className={`ws ${STATUS_CLASS[item.status] ?? "ws-lagging"}`}>
            {item.status}
          </div>
        </div>
      ))}
    </div>
  );
}
