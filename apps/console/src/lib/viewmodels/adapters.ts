import type {
  IncidentPacket,
  DiagnosisResult,
  ExtractedSpan,
  IncidentRawState,
  ChangedMetric,
  RepresentativeTrace,
} from "@3amoncall/core";
import type { Incident } from "../../api/types.js";
import type {
  IncidentWorkspaceVM,
  ChipVM,
  EvidenceEntryVM,
  ImpactTimelineVM,
  EvidenceStudioVM,
  ProofCardVM,
  ComponentFlowVM,
  TabKey,
  TraceGroupVM,
  SpanRowVM,
  SpanDetailVM,
  ProofCardV4VM,
  EvidenceStudioV4VM,
  SideNoteVM,
} from "./types.js";

type RecoveryStatus = "watch" | "ok" | "alert";
const VALID_RECOVERY_STATUSES: ReadonlyArray<string> = ["watch", "ok", "alert"];

function toRecoveryStatus(raw: string): RecoveryStatus {
  return VALID_RECOVERY_STATUSES.includes(raw) ? (raw as RecoveryStatus) : "watch";
}

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
      primaryText: compactAction(dr.recommendation.immediate_action),
      rationale: compactSentence(dr.recommendation.action_rationale_short, 160),
      doNot: compactSentence(dr.recommendation.do_not, 180),
    },
    recovery: {
      items: dr.operator_guidance.watch_items.map((item) => ({
        look: humanizeWatchLabel(item.label),
        means: compactSentence(item.state, 120),
        status: toRecoveryStatus(item.status),
      })),
    },
    cause: {
      hypothesis: dr.summary.root_cause_hypothesis,
      chain: dr.reasoning.causal_chain,
    },
    evidence: buildEvidenceEntryVM(packet),
    timeline: buildImpactTimelineVM(packet),
    copilot: {
      confidence: dr.confidence.confidence_assessment,
      uncertainty: dr.confidence.uncertainty,
      operatorCheck: dr.operator_guidance.operator_checks[0] ?? "\u2014",
    },
  };
}

function compactAction(text: string): string {
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (parts.length === 0) return text;
  const first = parts[0] ?? text;
  const second = parts[1];
  if (!second) return compactSentence(first, 180);
  return compactSentence(`${first} ${second}`, 220);
}

function compactSentence(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const firstClause = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
  if (firstClause.length <= maxChars) return firstClause;
  return `${firstClause.slice(0, maxChars - 1).trim()}…`;
}

function humanizeWatchLabel(label: string): string {
  if (!label.includes("_")) return label;
  return label
    .replace(/_total$/i, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function buildEvidenceEntryVM(packet: IncidentPacket): EvidenceEntryVM {
  return {
    traces: packet.evidence.representativeTraces.length,
    metrics: packet.evidence.changedMetrics.length,
    logs: packet.evidence.relevantLogs.length,
    platformEvents: packet.evidence.platformEvents.length,
    traceCount: new Set(
      packet.evidence.representativeTraces.map((t) => t.traceId),
    ).size,
  };
}

function formatTimeUTC(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

function buildImpactTimelineVM(packet: IncidentPacket): ImpactTimelineVM {
  const raw: Array<{ iso: string; label: string }> = [];

  raw.push({ iso: packet.window.start, label: "Incident window start" });
  for (const sig of packet.triggerSignals) {
    raw.push({ iso: sig.firstSeenAt, label: sig.signal });
  }
  raw.push({ iso: packet.window.detect, label: "Detected" });

  raw.sort((a, b) => a.iso.localeCompare(b.iso));

  const events = raw.map((r) => ({ time: formatTimeUTC(r.iso), label: r.label }));

  const seen = new Set<string>();
  const surfaceParts: string[] = [];
  const addPart = (s: string) => {
    if (s && !seen.has(s)) { seen.add(s); surfaceParts.push(s); }
  };
  for (const route of packet.scope.affectedRoutes) {
    addPart(route.replace(/^\//, "").split("/")[0] ?? "");
  }
  addPart(packet.scope.primaryService);
  for (const dep of packet.scope.affectedDependencies) {
    addPart(dep);
  }
  const surface = surfaceParts.join(", ");

  return { events, surface };
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

  const baseEvidenceSource = hasMetrics
    ? "metrics"
    : hasLogs
      ? "logs"
      : hasPlatformEvents
        ? "platform"
        : hasTraces
          ? "traces"
          : "diagnosis";

  const firstSignal = packet.triggerSignals[0];
  const firstDep = packet.scope.affectedDependencies[0];
  const externalStep = dr?.reasoning.causal_chain[0];
  const designStep = dr?.reasoning.causal_chain[1];
  const firstWatch = dr?.operator_guidance.watch_items[0];
  const firstTrace = packet.evidence.representativeTraces[0];

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

  const card2: ProofCardVM = {
    label: "Design Gap",
    proof:
      designStep?.title ??
      dr?.recommendation.action_rationale_short ??
      "Design gap analysis pending",
    sourceFamily: designStep ?? dr?.recommendation ? "diagnosis" : baseEvidenceSource,
    detail: designStep?.detail ?? "",
  };

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

  nodes.push({
    id: packet.scope.primaryService,
    label: packet.scope.primaryService,
    role: packet.scope.affectedDependencies.length > 0 ? "spread" : "cause",
  });

  for (const dep of packet.scope.affectedDependencies) {
    nodes.push({ id: dep, label: dep, role: "cause" });
    edges.push({ from: dep, to: packet.scope.primaryService });
  }

  const scopeImpactServices = packet.scope.affectedServices.filter(
    (svc) => svc !== packet.scope.primaryService,
  );

  for (const svc of scopeImpactServices) {
    nodes.push({ id: svc, label: svc, role: "impact" });
    edges.push({ from: packet.scope.primaryService, to: svc });
  }

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

// ── Evidence Studio v4 adapters ─────────────────────────────

export function buildTraceGroups(
  rawSpans: ExtractedSpan[],
  packetTraces: RepresentativeTrace[],
): TraceGroupVM[] {
  if (rawSpans.length === 0) return [];

  const packetSpanIds = new Set(packetTraces.map((t) => t.spanId));

  // Group spans by traceId
  const traceMap = new Map<string, ExtractedSpan[]>();
  for (const span of rawSpans) {
    const group = traceMap.get(span.traceId) ?? [];
    group.push(span);
    traceMap.set(span.traceId, group);
  }

  const groups: TraceGroupVM[] = [];

  for (const [traceId, spans] of traceMap) {
    // Find root: span with no parentSpanId, or parentSpanId not in this trace
    const traceSpanIds = new Set(spans.map((s) => s.spanId));
    const root =
      spans.find((s) => !s.parentSpanId || !traceSpanIds.has(s.parentSpanId)) ??
      spans[0];

    if (!root) continue;

    // DFS ordering
    const childMap = new Map<string, ExtractedSpan[]>();
    for (const span of spans) {
      if (span.parentSpanId && traceSpanIds.has(span.parentSpanId)) {
        const children = childMap.get(span.parentSpanId) ?? [];
        children.push(span);
        childMap.set(span.parentSpanId, children);
      }
    }

    const orderedSpans: SpanRowVM[] = [];
    function dfs(span: ExtractedSpan, depth: number) {
      orderedSpans.push({
        span,
        depth,
        isAiSelected: packetSpanIds.has(span.spanId),
      });
      const children = childMap.get(span.spanId) ?? [];
      for (const child of children) {
        dfs(child, depth + 1);
      }
    }
    dfs(root, 0);

    // Add orphans (spans with parentSpanId pointing outside this trace)
    for (const span of spans) {
      if (!orderedSpans.some((r) => r.span.spanId === span.spanId)) {
        orderedSpans.push({ span, depth: 0, isAiSelected: packetSpanIds.has(span.spanId) });
      }
    }

    const traceStartMs = Math.min(...spans.map((s) => s.startTimeMs));
    const traceEndMs = Math.max(...spans.map((s) => s.startTimeMs + s.durationMs));

    groups.push({
      traceId,
      rootSpan: root,
      method: root.httpMethod,
      route: root.httpRoute,
      rootStatus: root.httpStatusCode ?? root.spanStatusCode,
      totalDurationMs: traceEndMs - traceStartMs,
      spanCount: spans.length,
      orderedSpans,
      traceStartMs,
    });
  }

  // Sort: error traces first (rootStatus >= 400 or spanStatusCode === 2)
  groups.sort((a, b) => {
    const aError = a.rootSpan.spanStatusCode === 2 || (a.rootSpan.httpStatusCode ?? 0) >= 400;
    const bError = b.rootSpan.spanStatusCode === 2 || (b.rootSpan.httpStatusCode ?? 0) >= 400;
    if (aError && !bError) return -1;
    if (!aError && bError) return 1;
    return b.totalDurationMs - a.totalDurationMs;
  });

  return groups;
}

export function buildSpanDetailVM(
  span: ExtractedSpan,
  packetTraces: RepresentativeTrace[],
): SpanDetailVM {
  const isAiSelected = packetTraces.some((t) => t.spanId === span.spanId);
  return {
    spanId: span.spanId,
    spanName: span.spanName,
    serviceName: span.serviceName,
    httpRoute: span.httpRoute,
    httpMethod: span.httpMethod,
    httpStatusCode: span.httpStatusCode,
    spanStatusCode: span.spanStatusCode,
    spanKind: span.spanKind,
    durationMs: span.durationMs,
    startTimeMs: span.startTimeMs,
    peerService: span.peerService,
    exceptionCount: span.exceptionCount,
    parentSpanId: span.parentSpanId,
    isAiSelected,
  };
}

export function buildProofCardsV4(incident: Incident): ProofCardV4VM[] {
  const dr = incident.diagnosisResult;
  const packet = incident.packet;

  const firstSignal = packet.triggerSignals[0];
  const externalStep = dr?.reasoning.causal_chain[0];
  const designStep = dr?.reasoning.causal_chain[1];
  const firstWatch = dr?.operator_guidance.watch_items[0];

  const card1: ProofCardV4VM = {
    id: "trigger",
    label: "External Trigger",
    summary: externalStep?.title ?? firstSignal?.signal ?? "Unknown trigger",
    evidence: externalStep?.detail ?? firstSignal?.entity ?? "",
    targetTab: "traces",
    icon: "⚡",
    iconClass: "accent",
    status: externalStep ? "confirmed" : firstSignal ? "inferred" : "pending",
  };

  const card2: ProofCardV4VM = {
    id: "design-gap",
    label: "Design Gap",
    summary:
      designStep?.title ??
      dr?.recommendation.action_rationale_short ??
      "Design gap analysis pending",
    evidence: designStep?.detail ?? "",
    targetTab: "metrics",
    icon: "⚠",
    iconClass: "amber",
    status: designStep ? "confirmed" : dr ? "inferred" : "pending",
  };

  let recoverySummary: string;
  let recoveryStatus: ProofCardV4VM["status"];

  if (firstWatch) {
    recoverySummary = `${firstWatch.label}: ${firstWatch.state}`;
    recoveryStatus = "confirmed";
  } else if (dr) {
    recoverySummary = dr.confidence.confidence_assessment;
    recoveryStatus = "inferred";
  } else {
    recoverySummary = "Recovery signal pending";
    recoveryStatus = "pending";
  }

  const card3: ProofCardV4VM = {
    id: "recovery",
    label: "Recovery Signal",
    summary: recoverySummary,
    evidence: firstWatch?.status ?? "",
    targetTab: "logs",
    icon: "✓",
    iconClass: "good",
    status: recoveryStatus,
  };

  return [card1, card2, card3];
}

export function buildEvidenceStudioV4VM(
  incident: Incident,
  rawState: IncidentRawState,
): EvidenceStudioV4VM {
  const dr = incident.diagnosisResult;

  const title = dr?.summary?.what_happened
    ?? `Incident — ${incident.packet.scope.primaryService}`;

  const signalSeverity = incident.packet.signalSeverity;
  const severity: EvidenceStudioV4VM["severity"] =
    signalSeverity === "critical"
      ? "critical"
      : signalSeverity === "high" || signalSeverity === "medium"
        ? "warning"
        : "info";

  const tabCounts: Record<TabKey, number> = {
    traces: rawState.spans.length,
    metrics: rawState.metricEvidence.length,
    logs: rawState.logEvidence.length,
    platform: rawState.platformEvents.length,
  };

  const sideNotes: SideNoteVM[] = [];

  if (dr) {
    sideNotes.push({
      title: "Confidence",
      text: dr.confidence.confidence_assessment,
      accent: "teal",
    });
    if (dr.confidence.uncertainty) {
      sideNotes.push({
        title: "Uncertainty",
        text: dr.confidence.uncertainty,
        accent: "amber",
      });
    }
  }

  if (incident.packet.scope.affectedDependencies.length > 0) {
    sideNotes.push({
      title: "External Dependencies",
      text: incident.packet.scope.affectedDependencies.join(", "),
      accent: "amber",
    });
  }

  return {
    title,
    severity,
    proofCards: buildProofCardsV4(incident),
    tabCounts,
    sideNotes,
  };
}

export function extractMetricValue(summary: unknown): number {
  if (!summary || typeof summary !== "object") return 0;
  const s = summary as Record<string, unknown>;
  if (typeof s.asDouble === "number") return s.asDouble;
  if (typeof s.asInt === "number") return s.asInt;
  const count = typeof s.count === "number" ? s.count : 0;
  const sum = typeof s.sum === "number" ? s.sum : 0;
  if (count > 0) return sum / count;
  if (sum !== 0) return sum;
  if (typeof s.min === "number") return s.min;
  if (typeof s.max === "number") return s.max;
  return 0;
}

interface MetricSeriesPoint {
  timeMs: number;
  value: number;
}

export interface MetricSeries {
  key: string;
  name: string;
  service: string;
  points: MetricSeriesPoint[];
}

export function buildMetricsSeries(rawMetrics: ChangedMetric[]): MetricSeries[] {
  const map = new Map<string, MetricSeries>();

  for (const m of rawMetrics) {
    const key = `${m.name}::${m.service}`;
    const series = map.get(key) ?? { key, name: m.name, service: m.service, points: [] };
    series.points.push({
      timeMs: typeof m.startTimeMs === "number" ? m.startTimeMs : 0,
      value: extractMetricValue(m.summary),
    });
    map.set(key, series);
  }

  for (const series of map.values()) {
    series.points.sort((a, b) => a.timeMs - b.timeMs);
  }

  return Array.from(map.values());
}

export function buildStatCards(
  rawMetrics: ChangedMetric[],
  packetMetrics: ChangedMetric[],
): Array<{ key: string; name: string; service: string; value: number; highlighted: boolean }> {
  const packetKeys = new Set(packetMetrics.map((m) => `${m.name}::${m.service}`));
  const series = buildMetricsSeries(rawMetrics);

  return series
    .slice(0, 4)
    .map((s) => ({
      key: s.key,
      name: s.name,
      service: s.service,
      value: s.points[s.points.length - 1]?.value ?? 0,
      highlighted: packetKeys.has(s.key),
    }));
}
