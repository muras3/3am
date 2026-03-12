import type { IncidentPacket, DiagnosisResult } from "@3amoncall/core";
import type { Incident } from "../../api/types.js";
import type {
  IncidentWorkspaceVM,
  ChipVM,
  EvidenceStudioVM,
  ProofCardVM,
  ComponentFlowVM,
} from "./types.js";

export function buildIncidentWorkspaceVM(
  incident: Incident,
): IncidentWorkspaceVM | undefined {
  const { diagnosisResult: dr, packet } = incident;
  if (!dr) return undefined;

  return {
    incidentId: incident.incidentId,
    headline: dr.summary.what_happened,
    chips: buildChips(packet, dr),
    action: {
      primaryText: dr.recommendation.immediate_action,
      rationale: dr.recommendation.action_rationale_short,
      doNot: dr.recommendation.do_not,
    },
    recovery: {
      items: dr.operator_guidance.watch_items.map((item) => ({
        look: item.label,
        means: item.state,
        status: item.status as "watch" | "ok" | "alert",
      })),
    },
    cause: {
      hypothesis: dr.summary.root_cause_hypothesis,
      chain: dr.reasoning.causal_chain,
    },
    evidence: {
      traces: packet.evidence.representativeTraces.length,
      metrics: packet.evidence.changedMetrics.length,
      logs: packet.evidence.relevantLogs.length,
    },
    copilot: {
      confidence: dr.confidence.confidence_assessment,
      uncertainty: dr.confidence.uncertainty,
      operatorCheck: dr.operator_guidance.operator_checks[0] ?? "\u2014",
    },
  };
}

export function buildEvidenceStudioVM(incident: Incident): EvidenceStudioVM {
  return {
    proofCards: buildProofCards(incident.packet, incident.diagnosisResult),
    componentFlow: buildComponentFlow(incident.packet),
  };
}

function buildChips(packet: IncidentPacket, dr: DiagnosisResult): ChipVM[] {
  const chips: ChipVM[] = [];

  chips.push({ label: "customer-facing", kind: "critical" });

  if (packet.scope.affectedDependencies.length > 0) {
    chips.push({ label: "external dependency", kind: "external" });
  }

  const confLower = dr.confidence.confidence_assessment.toLowerCase();
  const confLevel = confLower.includes("high")
    ? "high"
    : confLower.includes("medium")
      ? "medium"
      : "low";
  chips.push({ label: `confidence: ${confLevel}`, kind: "system" });

  return chips;
}

function buildProofCards(
  packet: IncidentPacket,
  dr?: DiagnosisResult,
): ProofCardVM[] {
  const hasMetrics = packet.evidence.changedMetrics.length > 0;
  const hasLogs = packet.evidence.relevantLogs.length > 0;
  const hasPlatformEvents = packet.evidence.platformEvents.length > 0;
  const hasTraces = packet.evidence.representativeTraces.length > 0;

  // Degrade path 6: platform/logs/metrics all empty → use representative traces as sourceFamily
  // Degrade path 1: diagnosis present + evidence sparse → diagnosis-led
  let evidenceSource: string;
  if (hasMetrics) {
    evidenceSource = "metrics";
  } else if (hasLogs) {
    evidenceSource = "logs";
  } else if (hasPlatformEvents) {
    evidenceSource = "platform-logs";
  } else if (hasTraces) {
    evidenceSource = "traces";
  } else {
    evidenceSource = "diagnosis";
  }

  const firstSignal = packet.triggerSignals[0];
  const firstDep = packet.scope.affectedDependencies[0];
  const externalStep = dr?.reasoning.causal_chain[0];
  const designStep = dr?.reasoning.causal_chain[1];
  const firstWatch = dr?.operator_guidance.watch_items[0];
  const firstTrace = packet.evidence.representativeTraces[0];

  // Card 1: External Trigger
  const card1: ProofCardVM = {
    label: "External Trigger",
    proof:
      externalStep?.title ??
      firstSignal?.signal ??
      firstDep ??
      "Unknown trigger",
    sourceFamily: dr ? "diagnosis" : evidenceSource,
    detail: externalStep?.detail ?? firstSignal?.entity ?? "",
  };

  // Card 2: Design Gap
  const card2: ProofCardVM = {
    label: "Design Gap",
    proof:
      designStep?.title ??
      dr?.recommendation.action_rationale_short ??
      "Design gap analysis pending",
    sourceFamily: dr ? "diagnosis" : evidenceSource,
    detail: designStep?.detail ?? "",
  };

  // Card 3: Recovery Signal — prefer watch_items, degrade to traces
  let recoveryProof: string;
  if (firstWatch) {
    recoveryProof = `${firstWatch.label}: ${firstWatch.state}`;
  } else if (dr) {
    recoveryProof = dr.summary.what_happened;
  } else if (firstTrace) {
    recoveryProof = `${firstTrace.serviceName} span: ${firstTrace.httpStatusCode ?? firstTrace.spanStatusCode}`;
  } else {
    recoveryProof = "Recovery signal pending";
  }

  const card3: ProofCardVM = {
    label: "Recovery Signal",
    proof: recoveryProof,
    sourceFamily: evidenceSource,
    detail: firstWatch?.status ?? "",
  };

  return [card1, card2, card3];
}

function buildComponentFlow(packet: IncidentPacket): ComponentFlowVM {
  const nodes: ComponentFlowVM["nodes"] = [];
  const edges: ComponentFlowVM["edges"] = [];

  // Primary service is always a "cause" node (or "spread" if deps exist)
  nodes.push({
    id: packet.scope.primaryService,
    label: packet.scope.primaryService,
    role: packet.scope.affectedDependencies.length > 0 ? "spread" : "cause",
  });

  // Dependencies are "cause" nodes — they trigger the primary service degradation
  for (const dep of packet.scope.affectedDependencies) {
    nodes.push({ id: dep, label: dep, role: "cause" });
    edges.push({ from: dep, to: packet.scope.primaryService });
  }

  // Affected services (excluding primary) are "impact" nodes
  for (const svc of packet.scope.affectedServices) {
    if (svc !== packet.scope.primaryService) {
      nodes.push({ id: svc, label: svc, role: "impact" });
      edges.push({ from: packet.scope.primaryService, to: svc });
    }
  }

  return { nodes, edges };
}
