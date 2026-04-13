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
export const CuratedEvidenceRefSchema = z.strictObject({
  refId: z.string(),
  surface: z.enum(["traces", "metrics", "logs", "absences"]),
  groupId: z.string().optional(),
  isSmokingGun: z.boolean().optional(),
});

export const EvidenceIndexSchema = z.strictObject({
  spans: z.record(z.string(), CuratedEvidenceRefSchema),
  metrics: z.record(z.string(), CuratedEvidenceRefSchema),
  logs: z.record(z.string(), CuratedEvidenceRefSchema),
  absences: z.record(z.string(), CuratedEvidenceRefSchema),
});

// ── Diagnosis-owned narrative slots ──────────────────────────
// These shapes are NOT defined here. Diagnosis plan owns their contract.
// Receiver returns empty stubs; diagnosis Stage 2 populates them.
// The schema uses z.unknown() to avoid locking the shape prematurely.

// ── Baseline Context ─────────────────────────────────────────

export const BaselineSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("exact_operation"), operation: z.string(), service: z.string() }),
  z.strictObject({ kind: z.literal("same_operation_family"), operation: z.string(), service: z.string() }),
  z.strictObject({ kind: z.literal("none") }),
]);

export const BaselineContextSchema = z.strictObject({
  windowStart: z.string(),
  windowEnd: z.string(),
  sampleCount: z.number(),
  confidence: z.enum(["high", "medium", "low", "unavailable"]),
  source: BaselineSourceSchema,
});

// ── Traces Surface ───────────────────────────────────────────

export const CuratedTraceSpanSchema = z.strictObject({
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
});

export const CuratedGroupedTraceSchema = z.strictObject({
  traceId: z.string(),
  groupId: z.string(),
  rootSpanName: z.string(),
  httpStatusCode: z.number().optional(),
  durationMs: z.number(),
  status: z.enum(["ok", "error", "slow"]),
  startTimeMs: z.number(),
  spans: z.array(CuratedTraceSpanSchema),
});

export const CuratedTraceSurfaceSchema = z.strictObject({
  observed: z.array(CuratedGroupedTraceSchema),
  expected: z.array(CuratedGroupedTraceSchema),
  smokingGunSpanId: z.string().optional(),
  baseline: BaselineContextSchema,
});

// ── Metrics Surface ──────────────────────────────────────────

export const MetricGroupKeySchema = z.strictObject({
  service: z.string(),
  anomalyMagnitude: z.enum(["extreme", "significant", "moderate", "baseline"]),
  metricClass: z.enum(["error_rate", "latency", "throughput", "resource"]),
});

export const MetricRowSchema = z.strictObject({
  refId: z.string(),
  name: z.string(),
  service: z.string(),
  observedValue: z.union([z.number(), z.string()]),
  expectedValue: z.union([z.number(), z.string()]),
  deviation: z.number().nullable(),
  zScore: z.number().nullable(),
  impactBar: z.number(),
});

export const MetricGroupSchema = z.strictObject({
  groupId: z.string(),
  groupKey: MetricGroupKeySchema,
  diagnosisLabel: z.string().optional(),
  diagnosisVerdict: z.string().optional(),
  rows: z.array(MetricRowSchema),
});

export const CuratedMetricsSurfaceSchema = z.strictObject({
  groups: z.array(MetricGroupSchema),
});

// ── Logs Surface ─────────────────────────────────────────────

export const LogClusterKeySchema = z.strictObject({
  primaryService: z.string(),
  severityDominant: z.enum(["FATAL", "ERROR", "WARN", "INFO"]),
  hasTraceCorrelation: z.boolean(),
  keywordHits: z.array(z.string()),
});

export const CuratedLogEntrySchema = z.strictObject({
  refId: z.string(),
  timestamp: z.string(),
  severity: z.string(),
  body: z.string(),
  isSignal: z.boolean(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
});

export const LogClusterSchema = z.strictObject({
  clusterId: z.string(),
  clusterKey: LogClusterKeySchema,
  diagnosisLabel: z.string().optional(),
  diagnosisVerdict: z.string().optional(),
  entries: z.array(CuratedLogEntrySchema),
  signalCount: z.number(),
  noiseCount: z.number(),
});

export const AbsenceEvidenceEntrySchema = z.strictObject({
  refId: z.string(),
  kind: z.literal("absence"),
  patternId: z.string(),
  keywords: z.array(z.string()),
  matchCount: z.literal(0),
  searchWindow: z.strictObject({
    start: z.string(),
    end: z.string(),
  }),
  defaultLabel: z.string(),
  diagnosisLabel: z.string().optional(),
  diagnosisExpected: z.string().optional(),
  diagnosisExplanation: z.string().optional(),
});

export const CuratedLogsSurfaceSchema = z.strictObject({
  clusters: z.array(LogClusterSchema),
  absenceEvidence: z.array(AbsenceEvidenceEntrySchema),
});

// Public console-facing evidence response.
export const EvidenceRefSchema = AnswerEvidenceRefSchema;

export const CorrelatedLogSchema = z.strictObject({
  timestamp: z.string(),
  severity: z.string(),
  body: z.string(),
});

export const TraceSpanSchema = z.strictObject({
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  durationMs: z.number(),
  status: z.enum(["ok", "error", "slow"]),
  attributes: z.record(z.string(), z.unknown()),
  correlatedLogs: z.array(CorrelatedLogSchema).optional(),
});

export const TraceGroupSchema = z.strictObject({
  traceId: z.string(),
  route: z.string(),
  status: z.number(),
  durationMs: z.number(),
  expectedDurationMs: z.number().optional(),
  annotation: z.string().optional(),
  spans: z.array(TraceSpanSchema),
});

export const PublicBaselineSchema = z.strictObject({
  source: z.enum(["exact_operation", "same_operation_family", "none"]),
  windowStart: z.string(),
  windowEnd: z.string(),
  sampleCount: z.number(),
  confidence: z.enum(["high", "medium", "low", "unavailable"]),
});

export const TraceSurfaceSchema = z.strictObject({
  observed: z.array(TraceGroupSchema),
  expected: z.array(TraceGroupSchema),
  smokingGunSpanId: z.string().nullable(),
  baseline: PublicBaselineSchema.optional(),
});

export const HypothesisMetricSchema = z.strictObject({
  name: z.string(),
  value: z.string(),
  expected: z.string(),
  barPercent: z.number(),
});

export const HypothesisGroupSchema = z.strictObject({
  id: z.string(),
  type: z.enum(["trigger", "cascade", "recovery", "absence"]),
  claim: z.string(),
  verdict: z.enum(["Confirmed", "Inferred"]),
  metrics: z.array(HypothesisMetricSchema),
});

export const MetricsSurfaceSchema = z.strictObject({
  hypotheses: z.array(HypothesisGroupSchema),
});

export const LogEntrySchema = z.strictObject({
  timestamp: z.string(),
  severity: z.enum(["error", "warn", "info"]),
  body: z.string(),
  signal: z.boolean(),
});

export const LogClaimSchema = z.strictObject({
  id: z.string(),
  type: z.enum(["trigger", "cascade", "recovery", "absence"]),
  label: z.string(),
  count: z.number(),
  expected: z.string().optional(),
  observed: z.string().optional(),
  explanation: z.string().optional(),
  entries: z.array(LogEntrySchema),
});

export const LogsSurfaceSchema = z.strictObject({
  claims: z.array(LogClaimSchema),
});

export const ProofCardSchema = z.strictObject({
  id: ProofRefSchema.shape.cardId,
  label: z.string(),
  status: ProofRefSchema.shape.status,
  summary: z.string(),
  targetSurface: ProofRefSchema.shape.targetSurface,
  evidenceRefs: z.array(ProofRefSchema.shape.evidenceRefs.element),
});

export const EvidenceSummarySchema = z.strictObject({
  traces: z.number(),
  metrics: z.number(),
  logs: z.number(),
});

export const QABlockSchema = z.strictObject({
  question: z.string(),
  answer: z.string(),
  evidenceRefs: z.array(EvidenceRefSchema),
  status: z.enum(["answered", "no_answer"]).optional(),
  segments: z.array(z.strictObject({
    id: z.string(),
    kind: z.enum(["fact", "inference", "unknown"]),
    text: z.string().min(1),
    evidenceRefs: z.array(EvidenceRefSchema).min(1),
  })).optional(),
  evidenceSummary: EvidenceSummarySchema,
  followups: z.array(FollowupSchema),
  noAnswerReason: z.string().optional(),
});

// ── Evidence Query (POST /api/incidents/:id/evidence/query) ──

export const EvidenceQueryRequestSchema = z.strictObject({
  question: z.string().min(1).max(2000),
  isFollowup: z.boolean().optional(),
  isSystemFollowup: z.boolean().optional(),
  locale: z.enum(["en", "ja"]).optional(),
  replyToClarification: z.strictObject({
    originalQuestion: z.string(),
    clarificationText: z.string(),
  }).optional(),
  clarificationChainLength: z.number().int().min(0).max(10).optional(),
  history: z.array(z.strictObject({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(4000),
  })).max(20).optional(),
});

export const EvidenceQueryRefSchema = z.strictObject({
  kind: z.enum(["span", "metric_group", "log_cluster", "absence"]),
  id: z.string(),
});

export const EvidenceQuerySegmentSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["fact", "inference", "unknown"]),
  text: z.string().min(1),
  evidenceRefs: z.array(EvidenceQueryRefSchema).min(1),
});

export const EvidenceQueryStatusSchema = z.enum(["answered", "no_answer", "clarification"]);

export const EvidenceQueryResponseSchema = z.strictObject({
  question: z.string(),
  status: EvidenceQueryStatusSchema,
  segments: z.array(EvidenceQuerySegmentSchema),
  evidenceSummary: EvidenceSummarySchema,
  followups: z.array(FollowupSchema),
  noAnswerReason: z.string().optional(),
  clarificationQuestion: z.string().optional(),
});

export const SideNoteSchema = z.strictObject({
  title: z.string(),
  text: z.string(),
  kind: NarrativeSideNoteSchema.shape.kind,
});

export const EvidenceSurfacesSchema = z.strictObject({
  traces: TraceSurfaceSchema,
  metrics: MetricsSurfaceSchema,
  logs: LogsSurfaceSchema,
});

export const EvidenceResponseSchema = z.strictObject({
  proofCards: z.array(ProofCardSchema).length(3),
  qa: QABlockSchema,
  surfaces: EvidenceSurfacesSchema,
  sideNotes: z.array(SideNoteSchema),
  state: CuratedStateSchema,
});

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
