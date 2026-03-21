/**
 * Curated API types — the shared contract for the Lens console.
 *
 * These types define the shapes for the three curated API endpoints:
 *   - GET /api/runtime-map
 *   - GET /api/incidents/:id (extended)
 *   - GET /api/incidents/:id/evidence
 *
 * Shapes are derived from console-data-requirements.md §2.
 * Receiver, diagnosis, and frontend all consume these same types.
 */

// ── Shared enums ──────────────────────────────────────────────

export type NodeTier = "entry_point" | "runtime_unit" | "dependency";
export type HealthStatus = "healthy" | "degraded" | "critical";
export type EdgeKind = "internal" | "external";
export type CausalStepType = "external" | "system" | "incident" | "impact";
export type ProofCardStatus = "confirmed" | "inferred";
export type EvidenceSurface = "traces" | "metrics" | "logs";
export type ClaimType = "trigger" | "cascade" | "recovery" | "absence";
export type SpanStatus = "ok" | "error" | "slow";

/** §3.7 — Empty/Degraded state contract */
export interface CuratedState {
  diagnosis: "ready" | "pending" | "unavailable";
  baseline: "ready" | "insufficient" | "unavailable";
  evidenceDensity: "rich" | "sparse" | "empty";
}

// ── GET /api/runtime-map ──────────────────────────────────────

export interface RuntimeMapResponse {
  summary: RuntimeMapSummary;
  nodes: MapNode[];
  edges: MapEdge[];
  incidents: MapIncident[];
  state: Pick<CuratedState, "diagnosis">;
}

export interface RuntimeMapSummary {
  activeIncidents: number;
  degradedNodes: number;
  clusterReqPerSec: number;
  clusterP95Ms: number;
}

export interface MapNode {
  id: string;
  tier: NodeTier;
  label: string;
  subtitle: string;
  status: HealthStatus;
  metrics: Record<string, number>;
  badges: string[];
  incidentId?: string;
  positionHint?: number;
}

export interface MapEdge {
  fromNodeId: string;
  toNodeId: string;
  kind: EdgeKind;
  status: HealthStatus;
  label?: string;
  trafficHint?: string;
}

export interface MapIncident {
  incidentId: string;
  label: string;
  severity: string;
  openedAgo: string;
}

// ── GET /api/incidents/:id (extended) ─────────────────────────

export interface ExtendedIncident {
  incidentId: string;
  status: "open" | "closed";
  severity: string;
  openedAt: string;
  closedAt?: string;
  headline: string;
  chips: IncidentChip[];
  action: IncidentAction;
  rootCauseHypothesis: string;
  causalChain: CausalStep[];
  operatorChecks: string[];
  impactSummary: ImpactSummary;
  blastRadius: BlastRadiusEntry[];
  confidenceSummary: ConfidenceSummary;
  evidenceSummary: EvidenceCounts;
  state: CuratedState;
}

export interface IncidentChip {
  type: "critical" | "system" | "external";
  label: string;
}

export interface IncidentAction {
  text: string;
  rationale: string;
  doNot: string;
}

export interface CausalStep {
  type: CausalStepType;
  tag: string;
  title: string;
  detail: string;
}

export interface ImpactSummary {
  startedAt: string;
  fullCascadeAt: string;
  diagnosedAt: string;
}

export interface BlastRadiusEntry {
  target: string;
  status: HealthStatus;
  impactValue: number;
  label: string;
}

export interface ConfidenceSummary {
  label: string;
  value: number;
  basis: string;
  risk: string;
}

export interface EvidenceCounts {
  traces: number;
  traceErrors: number;
  metrics: number;
  logs: number;
  logErrors: number;
}

// ── GET /api/incidents/:id/evidence ───────────────────────────

export interface EvidenceResponse {
  proofCards: ProofCard[];
  qa: QABlock | null;
  surfaces: EvidenceSurfaces;
  sideNotes: SideNote[];
  state: CuratedState;
}

export interface ProofCard {
  id: string;
  label: string;
  status: ProofCardStatus;
  summary: string;
  targetSurface: EvidenceSurface;
  evidenceRefs: EvidenceRef[];
}

export interface EvidenceRef {
  kind: "span" | "metric" | "log" | "proof_card";
  id: string;
}

export interface QABlock {
  question: string;
  answer: string;
  evidenceRefs: EvidenceRef[];
  evidenceSummary: { traces: number; metrics: number; logs: number };
  followups: string[];
  noAnswerReason?: string;
}

export interface EvidenceSurfaces {
  traces: TraceSurface;
  metrics: MetricsSurface;
  logs: LogsSurface;
}

// ── Trace surface ─────────────────────────────────────────────

export interface TraceSurface {
  observed: TraceGroup[];
  expected: TraceGroup[];
  smokingGunSpanId: string | null;
}

export interface TraceGroup {
  traceId: string;
  route: string;
  status: number;
  durationMs: number;
  expectedDurationMs?: number;
  annotation?: string;
  spans: TraceSpan[];
}

export interface TraceSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  durationMs: number;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  correlatedLogs?: CorrelatedLog[];
}

export interface CorrelatedLog {
  timestamp: string;
  severity: string;
  body: string;
}

// ── Metrics surface ───────────────────────────────────────────

export interface MetricsSurface {
  hypotheses: HypothesisGroup[];
}

export interface HypothesisGroup {
  id: string;
  type: ClaimType;
  claim: string;
  verdict: "Confirmed" | "Inferred";
  metrics: HypothesisMetric[];
}

export interface HypothesisMetric {
  name: string;
  value: string;
  expected: string;
  barPercent: number;
}

// ── Logs surface ──────────────────────────────────────────────

export interface LogsSurface {
  claims: LogClaim[];
}

export interface LogClaim {
  id: string;
  type: ClaimType;
  label: string;
  count: number;
  entries: LogEntry[];
}

export interface LogEntry {
  timestamp: string;
  severity: "error" | "warn" | "info";
  body: string;
  signal: boolean;
}

// ── Side notes ────────────────────────────────────────────────

export interface SideNote {
  title: string;
  content: string;
  variant?: "primary";
}
