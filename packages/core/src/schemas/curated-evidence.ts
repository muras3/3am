import { z } from "zod";
import {
  AnswerEvidenceRefSchema,
  FollowupSchema,
  NarrativeSideNoteSchema,
} from "./console-narrative.js";
import type { NarrativeAbsenceEvidenceSchema } from "./console-narrative.js";
import { ProofRefSchema } from "./reasoning-structure.js";
import { CuratedStateSchema } from "./runtime-map.js";

// Internal receiver-facing evidence ref system.
export const CuratedEvidenceRefSchema = z.object({
  refId: z.string(),
  surface: z.enum(["traces", "metrics", "logs", "absences"]),
  groupId: z.string().optional(),
  isSmokingGun: z.boolean().optional(),
}).strict();

export const EvidenceIndexSchema = z.object({
  spans: z.record(z.string(), CuratedEvidenceRefSchema),
  metrics: z.record(z.string(), CuratedEvidenceRefSchema),
  logs: z.record(z.string(), CuratedEvidenceRefSchema),
  absences: z.record(z.string(), CuratedEvidenceRefSchema),
}).strict();

// ── Diagnosis-owned narrative slots ──────────────────────────
// These shapes are NOT defined here. Diagnosis plan owns their contract.
// Receiver returns empty stubs; diagnosis Stage 2 populates them.
// The schema uses z.unknown() to avoid locking the shape prematurely.

// ── Baseline Context ─────────────────────────────────────────

export const BaselineSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact_operation"), operation: z.string(), service: z.string() }).strict(),
  z.object({ kind: z.literal("same_operation_family"), operation: z.string(), service: z.string() }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);

export const BaselineContextSchema = z.object({
  windowStart: z.string(),
  windowEnd: z.string(),
  sampleCount: z.number(),
  confidence: z.enum(["high", "medium", "low", "unavailable"]),
  source: BaselineSourceSchema,
}).strict();

// ── Traces Surface ───────────────────────────────────────────

export const CuratedTraceSpanSchema = z.object({
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  refId: z.string(),
  spanName: z.string(),
  durationMs: z.number(),
  httpStatusCode: z.number().optional(),
  spanStatusCode: z.number(),
  offsetMs: z.number(),
  widthPct: z.number(),
  status: z.enum(["ok", "error", "slow"]),
  peerService: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()),
  correlatedLogRefIds: z.array(z.string()),
}).strict();

export const CuratedGroupedTraceSchema = z.object({
  traceId: z.string(),
  groupId: z.string(),
  rootSpanName: z.string(),
  httpStatusCode: z.number().optional(),
  durationMs: z.number(),
  status: z.enum(["ok", "error", "slow"]),
  startTimeMs: z.number(),
  spans: z.array(CuratedTraceSpanSchema),
}).strict();

export const CuratedTraceSurfaceSchema = z.object({
  observed: z.array(CuratedGroupedTraceSchema),
  expected: z.array(CuratedGroupedTraceSchema),
  smokingGunSpanId: z.string().optional(),
  baseline: BaselineContextSchema,
}).strict();

// ── Metrics Surface ──────────────────────────────────────────

export const MetricGroupKeySchema = z.object({
  service: z.string(),
  anomalyMagnitude: z.enum(["extreme", "significant", "moderate", "baseline"]),
  metricClass: z.enum(["error_rate", "latency", "throughput", "resource"]),
}).strict();

export const MetricRowSchema = z.object({
  refId: z.string(),
  name: z.string(),
  service: z.string(),
  observedValue: z.union([z.number(), z.string()]),
  expectedValue: z.union([z.number(), z.string()]),
  deviation: z.number().nullable(),
  zScore: z.number().nullable(),
  impactBar: z.number(),
}).strict();

export const MetricGroupSchema = z.object({
  groupId: z.string(),
  groupKey: MetricGroupKeySchema,
  diagnosisLabel: z.string().optional(),
  diagnosisVerdict: z.string().optional(),
  rows: z.array(MetricRowSchema),
}).strict();

export const CuratedMetricsSurfaceSchema = z.object({
  groups: z.array(MetricGroupSchema),
}).strict();

// ── Logs Surface ─────────────────────────────────────────────

export const LogClusterKeySchema = z.object({
  primaryService: z.string(),
  severityDominant: z.enum(["FATAL", "ERROR", "WARN", "INFO"]),
  hasTraceCorrelation: z.boolean(),
  keywordHits: z.array(z.string()),
}).strict();

export const CuratedLogEntrySchema = z.object({
  refId: z.string(),
  timestamp: z.string(),
  severity: z.string(),
  body: z.string(),
  isSignal: z.boolean(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
}).strict();

export const LogClusterSchema = z.object({
  clusterId: z.string(),
  clusterKey: LogClusterKeySchema,
  diagnosisLabel: z.string().optional(),
  diagnosisVerdict: z.string().optional(),
  entries: z.array(CuratedLogEntrySchema),
  signalCount: z.number(),
  noiseCount: z.number(),
}).strict();

export const AbsenceEvidenceEntrySchema = z.object({
  refId: z.string(),
  kind: z.literal("absence"),
  patternId: z.string(),
  keywords: z.array(z.string()),
  matchCount: z.literal(0),
  searchWindow: z.object({
    start: z.string(),
    end: z.string(),
  }).strict(),
  defaultLabel: z.string(),
  diagnosisLabel: z.string().optional(),
  diagnosisExpected: z.string().optional(),
  diagnosisExplanation: z.string().optional(),
}).strict();

export const CuratedLogsSurfaceSchema = z.object({
  clusters: z.array(LogClusterSchema),
  absenceEvidence: z.array(AbsenceEvidenceEntrySchema),
}).strict();

// Public console-facing evidence response.
export const EvidenceRefSchema = AnswerEvidenceRefSchema;

export const CorrelatedLogSchema = z.object({
  timestamp: z.string(),
  severity: z.string(),
  body: z.string(),
}).strict();

export const TraceSpanSchema = z.object({
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  durationMs: z.number(),
  status: z.enum(["ok", "error", "slow"]),
  attributes: z.record(z.string(), z.unknown()),
  correlatedLogs: z.array(CorrelatedLogSchema).optional(),
}).strict();

export const TraceGroupSchema = z.object({
  traceId: z.string(),
  route: z.string(),
  status: z.number(),
  durationMs: z.number(),
  expectedDurationMs: z.number().optional(),
  annotation: z.string().optional(),
  spans: z.array(TraceSpanSchema),
}).strict();

export const PublicBaselineSchema = z.object({
  source: z.enum(["exact_operation", "same_operation_family", "none"]),
  windowStart: z.string(),
  windowEnd: z.string(),
  sampleCount: z.number(),
  confidence: z.enum(["high", "medium", "low", "unavailable"]),
}).strict();

export const TraceSurfaceSchema = z.object({
  observed: z.array(TraceGroupSchema),
  expected: z.array(TraceGroupSchema),
  smokingGunSpanId: z.string().nullable(),
  baseline: PublicBaselineSchema.optional(),
}).strict();

export const HypothesisMetricSchema = z.object({
  name: z.string(),
  value: z.string(),
  expected: z.string(),
  barPercent: z.number(),
}).strict();

export const HypothesisGroupSchema = z.object({
  id: z.string(),
  type: z.enum(["trigger", "cascade", "recovery", "absence"]),
  claim: z.string(),
  verdict: z.enum(["Confirmed", "Inferred"]),
  metrics: z.array(HypothesisMetricSchema),
}).strict();

export const MetricsSurfaceSchema = z.object({
  hypotheses: z.array(HypothesisGroupSchema),
}).strict();

export const LogEntrySchema = z.object({
  timestamp: z.string(),
  severity: z.enum(["error", "warn", "info"]),
  body: z.string(),
  signal: z.boolean(),
}).strict();

export const LogClaimSchema = z.object({
  id: z.string(),
  type: z.enum(["trigger", "cascade", "recovery", "absence"]),
  label: z.string(),
  count: z.number(),
  expected: z.string().optional(),
  observed: z.string().optional(),
  explanation: z.string().optional(),
  entries: z.array(LogEntrySchema),
}).strict();

export const LogsSurfaceSchema = z.object({
  claims: z.array(LogClaimSchema),
}).strict();

export const ProofCardSchema = z.object({
  id: ProofRefSchema.shape.cardId,
  label: z.string(),
  status: ProofRefSchema.shape.status,
  summary: z.string(),
  targetSurface: ProofRefSchema.shape.targetSurface,
  evidenceRefs: z.array(ProofRefSchema.shape.evidenceRefs.element),
}).strict();

export const EvidenceSummarySchema = z.object({
  traces: z.number(),
  metrics: z.number(),
  logs: z.number(),
}).strict();

export const QABlockSchema = z.object({
  question: z.string(),
  answer: z.string(),
  evidenceRefs: z.array(EvidenceRefSchema),
  status: z.enum(["answered", "no_answer"]).optional(),
  segments: z.array(z.object({
    id: z.string(),
    kind: z.enum(["fact", "inference", "unknown"]),
    text: z.string().min(1),
    evidenceRefs: z.array(EvidenceRefSchema).min(1),
  }).strict()).optional(),
  evidenceSummary: EvidenceSummarySchema,
  followups: z.array(FollowupSchema),
  noAnswerReason: z.string().optional(),
}).strict();

// ── Evidence Query (POST /api/incidents/:id/evidence/query) ──

export const EvidenceQueryRequestSchema = z.object({
  question: z.string().min(1).max(2000),
  isFollowup: z.boolean().optional(),
  locale: z.enum(["en", "ja"]).optional(),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(4000),
  }).strict()).max(20).optional(),
}).strict();

export const EvidenceQueryRefSchema = z.object({
  kind: z.enum(["span", "metric_group", "log_cluster", "absence"]),
  id: z.string(),
}).strict();

export const EvidenceQuerySegmentSchema = z.object({
  id: z.string(),
  kind: z.enum(["fact", "inference", "unknown"]),
  text: z.string().min(1),
  evidenceRefs: z.array(EvidenceQueryRefSchema).min(1),
}).strict();

export const EvidenceQueryStatusSchema = z.enum(["answered", "no_answer", "clarification"]);

export const EvidenceQueryResponseSchema = z.object({
  question: z.string(),
  status: EvidenceQueryStatusSchema,
  segments: z.array(EvidenceQuerySegmentSchema),
  evidenceSummary: EvidenceSummarySchema,
  followups: z.array(FollowupSchema),
  noAnswerReason: z.string().optional(),
  clarificationQuestion: z.string().optional(),
}).strict();

export const SideNoteSchema = z.object({
  title: z.string(),
  text: z.string(),
  kind: NarrativeSideNoteSchema.shape.kind,
}).strict();

export const EvidenceSurfacesSchema = z.object({
  traces: TraceSurfaceSchema,
  metrics: MetricsSurfaceSchema,
  logs: LogsSurfaceSchema,
}).strict();

export const EvidenceResponseSchema = z.object({
  proofCards: z.array(ProofCardSchema).length(3),
  qa: QABlockSchema,
  surfaces: EvidenceSurfacesSchema,
  sideNotes: z.array(SideNoteSchema),
  state: CuratedStateSchema,
}).strict();

export type EvidenceIndex = z.infer<typeof EvidenceIndexSchema>;
export type CuratedEvidenceRef = z.infer<typeof CuratedEvidenceRefSchema>;
export type BaselineContext = z.infer<typeof BaselineContextSchema>;
export type BaselineSource = z.infer<typeof BaselineSourceSchema>;
export type CuratedTraceSurface = z.infer<typeof CuratedTraceSurfaceSchema>;
export type CuratedGroupedTrace = z.infer<typeof CuratedGroupedTraceSchema>;
export type CuratedTraceSpan = z.infer<typeof CuratedTraceSpanSchema>;
export type CuratedMetricsSurface = z.infer<typeof CuratedMetricsSurfaceSchema>;
export type MetricGroup = z.infer<typeof MetricGroupSchema>;
export type MetricGroupKey = z.infer<typeof MetricGroupKeySchema>;
export type MetricRow = z.infer<typeof MetricRowSchema>;
export type CuratedLogsSurface = z.infer<typeof CuratedLogsSurfaceSchema>;
export type LogCluster = z.infer<typeof LogClusterSchema>;
export type LogClusterKey = z.infer<typeof LogClusterKeySchema>;
export type CuratedLogEntry = z.infer<typeof CuratedLogEntrySchema>;
export type AbsenceEvidenceEntry = z.infer<typeof AbsenceEvidenceEntrySchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type CorrelatedLog = z.infer<typeof CorrelatedLogSchema>;
export type TraceSpan = z.infer<typeof TraceSpanSchema>;
export type TraceGroup = z.infer<typeof TraceGroupSchema>;
export type PublicBaseline = z.infer<typeof PublicBaselineSchema>;
export type TraceSurface = z.infer<typeof TraceSurfaceSchema>;
export type HypothesisMetric = z.infer<typeof HypothesisMetricSchema>;
export type HypothesisGroup = z.infer<typeof HypothesisGroupSchema>;
export type MetricsSurface = z.infer<typeof MetricsSurfaceSchema>;
export type LogEntry = z.infer<typeof LogEntrySchema>;
export type LogClaim = z.infer<typeof LogClaimSchema>;
export type LogsSurface = z.infer<typeof LogsSurfaceSchema>;
export type ProofCard = z.infer<typeof ProofCardSchema>;
export type EvidenceSummary = z.infer<typeof EvidenceSummarySchema>;
export type QABlock = z.infer<typeof QABlockSchema>;
export type SideNote = z.infer<typeof SideNoteSchema>;
export type EvidenceSurfaces = z.infer<typeof EvidenceSurfacesSchema>;
export type EvidenceResponse = z.infer<typeof EvidenceResponseSchema>;
export type NarrativeAbsenceEvidence = z.infer<typeof NarrativeAbsenceEvidenceSchema>;
export type EvidenceQueryRequest = z.infer<typeof EvidenceQueryRequestSchema>;
export type EvidenceQueryRef = z.infer<typeof EvidenceQueryRefSchema>;
export type EvidenceQuerySegment = z.infer<typeof EvidenceQuerySegmentSchema>;
export type EvidenceQueryStatus = z.infer<typeof EvidenceQueryStatusSchema>;
export type EvidenceQueryResponse = z.infer<typeof EvidenceQueryResponseSchema>;
