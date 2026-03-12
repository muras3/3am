import type { RecoveryVM } from "../../lib/viewmodels/index.js";

const STATUS_CLASS: Record<string, string> = {
  watch: "ws-watch",
  ok: "ws-ok",
  alert: "ws-lagging",
};

interface Props {
  recovery: RecoveryVM;
}

export function RecoveryCard({ recovery }: Props) {
  return (
    <section className="section-recovery" data-section="recovery">
      <div className="card-title">Recovery</div>
      {recovery.items.map((item, i) => (
        <div key={i} className="watch-row">
          <div className="wl">{item.look}</div>
          <div className="wv">{item.means}</div>
          <div className={`ws ${STATUS_CLASS[item.status] ?? "ws-lagging"}`}>
            {item.status}
          </div>
        </div>
      ))}
    </section>
  );
}
