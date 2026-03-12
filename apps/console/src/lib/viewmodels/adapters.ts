import type { IncidentPacket, DiagnosisResult } from "@3amoncall/core";

type RecoveryStatus = "watch" | "ok" | "alert";
const VALID_RECOVERY_STATUSES: ReadonlyArray<string> = ["watch", "ok", "alert"];

function toRecoveryStatus(raw: string): RecoveryStatus {
  return VALID_RECOVERY_STATUSES.includes(raw) ? (raw as RecoveryStatus) : "watch";
}
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
        status: toRecoveryStatus(item.status),
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
    componentFlow: buildComponentFlow(incident.packet, incident.diagnosisResult),
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

  // Base evidence source used when no more specific source applies (degrade path 6)
  const baseEvidenceSource = hasMetrics
    ? "metrics"
    : hasLogs
      ? "logs"
      : hasPlatformEvents
        ? "platform-logs"
        : hasTraces
          ? "traces"
          : "diagnosis";

  const firstSignal = packet.triggerSignals[0];
  const firstDep = packet.scope.affectedDependencies[0];
  const externalStep = dr?.reasoning.causal_chain[0];
  const designStep = dr?.reasoning.causal_chain[1];
  const firstWatch = dr?.operator_guidance.watch_items[0];
  const firstTrace = packet.evidence.representativeTraces[0];

  // Card 1: External Trigger — per-card sourceFamily based on actual data used
  const card1: ProofCardVM = {
    label: "External Trigger",
    proof:
      externalStep?.title ??
      firstSignal?.signal ??
      firstDep ??
      "Unknown trigger",
    sourceFamily: externalStep
      ? "diagnosis"
      : firstSignal
        ? "triggers"
        : baseEvidenceSource,
    detail: externalStep?.detail ?? firstSignal?.entity ?? "",
  };

  // Card 2: Design Gap — per-card sourceFamily
  const card2: ProofCardVM = {
    label: "Design Gap",
    proof:
      designStep?.title ??
      dr?.recommendation.action_rationale_short ??
      "Design gap analysis pending",
    sourceFamily: designStep ?? dr?.recommendation ? "diagnosis" : baseEvidenceSource,
    detail: designStep?.detail ?? "",
  };

  // Card 3: Recovery Signal — per-card sourceFamily based on actual data used
  let recoveryProof: string;
  let card3SourceFamily: string;

  if (firstWatch) {
    recoveryProof = `${firstWatch.label}: ${firstWatch.state}`;
    card3SourceFamily = "operator-guidance";
  } else if (dr) {
    recoveryProof = dr.summary.what_happened;
    card3SourceFamily = "diagnosis";
  } else if (firstTrace) {
    recoveryProof = `${firstTrace.serviceName} span: ${firstTrace.httpStatusCode ?? firstTrace.spanStatusCode}`;
    card3SourceFamily = "traces";
  } else {
    recoveryProof = "Recovery signal pending";
    card3SourceFamily = baseEvidenceSource;
  }

  const card3: ProofCardVM = {
    label: "Recovery Signal",
    proof: recoveryProof,
    sourceFamily: card3SourceFamily,
    detail: firstWatch?.status ?? "",
  };

  return [card1, card2, card3];
}

function buildComponentFlow(
  packet: IncidentPacket,
  dr?: DiagnosisResult,
): ComponentFlowVM {
  const nodes: ComponentFlowVM["nodes"] = [];
  const edges: ComponentFlowVM["edges"] = [];

  // Primary service is "spread" when it has upstream deps, "cause" otherwise
  nodes.push({
    id: packet.scope.primaryService,
    label: packet.scope.primaryService,
    role: packet.scope.affectedDependencies.length > 0 ? "spread" : "cause",
  });

  // Dependencies are "cause" nodes — they trigger primary service degradation
  for (const dep of packet.scope.affectedDependencies) {
    nodes.push({ id: dep, label: dep, role: "cause" });
    edges.push({ from: dep, to: packet.scope.primaryService });
  }

  // Impact nodes from scope.affectedServices (excluding primary)
  const scopeImpactServices = packet.scope.affectedServices.filter(
    (svc) => svc !== packet.scope.primaryService,
  );

  for (const svc of scopeImpactServices) {
    nodes.push({ id: svc, label: svc, role: "impact" });
    edges.push({ from: packet.scope.primaryService, to: svc });
  }

  // Degrade: if affectedServices is sparse, supplement impact nodes from causal chain
  if (scopeImpactServices.length === 0 && dr) {
    for (const step of dr.reasoning.causal_chain) {
      if (step.type === "impact") {
        const nodeId = `chain-impact:${step.title}`;
        nodes.push({ id: nodeId, label: step.title, role: "impact" });
        edges.push({ from: packet.scope.primaryService, to: nodeId });
      }
    }
  }

  return { nodes, edges };
}
