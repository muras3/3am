import type { RecoveryVM } from "../../lib/viewmodels/index.js";

const STATUS_CLASS: Record<RecoveryVM["items"][number]["status"], string> = {
  watch: "ws-watch",
  ok: "ws-ok",
  alert: "ws-lagging",
};

interface Props {
  recovery: RecoveryVM;
}

export function MitigationWatch({ recovery }: Props) {
  return (
    <div className="bottom-card" data-section="mitigation-watch">
      <div className="card-title">Mitigation Watch</div>
      {recovery.items.map((item, i) => (
        <div key={i} className="watch-row">
          <div className="wl">{item.look}</div>
          <div className="wv">{item.means}</div>
          <div className={`ws ${STATUS_CLASS[item.status] ?? "ws-lagging"}`}>
            {item.status}
          </div>
        </div>
      ))}
    </div>
  );
}
