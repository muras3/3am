import type { Incident } from "../../api/types.js";
import { Chip } from "../common/Chip.js";

interface Props {
  incident: Incident;
}

export function WhatHappened({ incident }: Props) {
  const dr = incident.diagnosisResult;
  if (!dr) return null;

  const hasDeps = incident.packet.scope.affectedDependencies.length > 0;
  const confLower = dr.confidence.confidence_assessment.toLowerCase();
  const confLevel = confLower.includes("high")
    ? "high"
    : confLower.includes("medium")
      ? "medium"
      : "low";

  return (
    <section className="section-what">
      <div className="headline">{dr.summary.what_happened}</div>
      <div className="impact-chips">
        {/* Phase D simplification: all incidents diagnosed by this system affect the customer-facing path.
            Phase E: derive this from packet.scope or diagnosisResult metadata. */}
        <Chip label="customer-facing" variant="critical" />
        {hasDeps && <Chip label="external dependency" variant="external" />}
        <Chip label={`confidence: ${confLevel}`} variant="system" />
      </div>
    </section>
  );
}
