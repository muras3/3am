import { z } from "zod";

// CuratedEvidenceResponse — GET /api/incidents/:id/evidence
// All sub-schemas use .strict() to reject unknown keys at every nesting level.

// ── Evidence Ref System ──────────────────────────────────────

const EvidenceRefSchema = z.object({
  refId: z.string(),
  surface: z.enum(["traces", "metrics", "logs", "absences"]),
  groupId: z.string().optional(),
  isSmokingGun: z.boolean().optional(),
}).strict();

const EvidenceIndexSchema = z.object({
  spans: z.record(z.string(), EvidenceRefSchema),
  metrics: z.record(z.string(), EvidenceRefSchema),
  logs: z.record(z.string(), EvidenceRefSchema),
  absences: z.record(z.string(), EvidenceRefSchema),
}).strict();

// ── Diagnosis-owned type stubs ───────────────────────────────
// Minimal shapes. Diagnosis plan will finalize these.

const ProofCardSchema = z.object({
  id: z.string(),
  targetSurface: z.enum(["traces", "metrics", "logs"]),
  evidenceRefIds: z.array(z.string()),
  label: z.string().optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
}).strict();

const QAFrameSchema = z.object({
  question: z.string(),
  answer: z.string(),
  evidenceRefIds: z.array(z.string()),
  confidence: z.object({
    label: z.string(),
    value: z.number(),
  }).strict().optional(),
  followups: z.array(z.string()),
  noAnswerReason: z.string().optional(),
}).strict();

const SideNoteSchema = z.object({
  title: z.string(),
  body: z.string(),
  kind: z.enum(["confidence", "uncertainty", "dependency", "context"]),
}).strict();

// ── Baseline Context ─────────────────────────────────────────

const BaselineSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("same_route"), route: z.string(), service: z.string() }).strict(),
  z.object({ kind: z.literal("same_service"), service: z.string() }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);

const BaselineContextSchema = z.object({
  windowStart: z.string(),
  windowEnd: z.string(),
  sampleCount: z.number(),
  confidence: z.enum(["high", "medium", "low", "unavailable"]),
  source: BaselineSourceSchema,
}).strict();

// ── Traces Surface ───────────────────────────────────────────

const TraceSpanSchema = z.object({
  spanId: z.string(),
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

const GroupedTraceSchema = z.object({
  traceId: z.string(),
  groupId: z.string(),
  rootSpanName: z.string(),
  httpStatusCode: z.number().optional(),
  durationMs: z.number(),
  status: z.enum(["ok", "error", "slow"]),
  startTimeMs: z.number(),
  spans: z.array(TraceSpanSchema),
}).strict();

const TraceSurfaceSchema = z.object({
  observed: z.array(GroupedTraceSchema),
  expected: z.array(GroupedTraceSchema),
  smokingGunSpanId: z.string().optional(),
  baseline: BaselineContextSchema,
}).strict();

// ── Metrics Surface ──────────────────────────────────────────

const MetricGroupKeySchema = z.object({
  service: z.string(),
  anomalyMagnitude: z.enum(["extreme", "significant", "moderate", "baseline"]),
  metricClass: z.enum(["error_rate", "latency", "throughput", "resource"]),
}).strict();

const MetricRowSchema = z.object({
  refId: z.string(),
  name: z.string(),
  service: z.string(),
  observedValue: z.union([z.number(), z.string()]),
  expectedValue: z.union([z.number(), z.string()]),
  deviation: z.number().nullable(),
  zScore: z.number().nullable(),
  impactBar: z.number(),
}).strict();

const MetricGroupSchema = z.object({
  groupId: z.string(),
  groupKey: MetricGroupKeySchema,
  diagnosisLabel: z.string().optional(),
  diagnosisVerdict: z.string().optional(),
  rows: z.array(MetricRowSchema),
}).strict();

const MetricsSurfaceSchema = z.object({
  groups: z.array(MetricGroupSchema),
}).strict();

// ── Logs Surface ─────────────────────────────────────────────

const LogClusterKeySchema = z.object({
  primaryService: z.string(),
  severityDominant: z.enum(["FATAL", "ERROR", "WARN", "INFO"]),
  hasTraceCorrelation: z.boolean(),
  keywordHits: z.array(z.string()),
}).strict();

const LogEntrySchema = z.object({
  refId: z.string(),
  timestamp: z.string(),
  severity: z.string(),
  body: z.string(),
  isSignal: z.boolean(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
}).strict();

const LogClusterSchema = z.object({
  clusterId: z.string(),
  clusterKey: LogClusterKeySchema,
  diagnosisLabel: z.string().optional(),
  diagnosisVerdict: z.string().optional(),
  entries: z.array(LogEntrySchema),
  signalCount: z.number(),
  noiseCount: z.number(),
}).strict();

const AbsenceEvidenceEntrySchema = z.object({
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

const LogsSurfaceSchema = z.object({
  clusters: z.array(LogClusterSchema),
  absenceEvidence: z.array(AbsenceEvidenceEntrySchema),
}).strict();

// ── Top-level Response ───────────────────────────────────────

export const CuratedEvidenceResponseSchema = z.object({
  proofCards: z.array(ProofCardSchema),
  qa: QAFrameSchema.nullable(),
  sideNotes: z.array(SideNoteSchema),
  surfaces: z.object({
    traces: TraceSurfaceSchema,
    metrics: MetricsSurfaceSchema,
    logs: LogsSurfaceSchema,
  }).strict(),
  evidenceIndex: EvidenceIndexSchema,
  state: z.object({
    diagnosis: z.enum(["ready", "pending", "unavailable"]),
    baseline: z.enum(["ready", "insufficient", "unavailable"]),
  }).strict(),
}).strict();

// ── Exports ──────────────────────────────────────────────────

export type CuratedEvidenceResponse = z.infer<typeof CuratedEvidenceResponseSchema>;
export type EvidenceIndex = z.infer<typeof EvidenceIndexSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type ProofCard = z.infer<typeof ProofCardSchema>;
export type QAFrame = z.infer<typeof QAFrameSchema>;
export type SideNote = z.infer<typeof SideNoteSchema>;
export type BaselineContext = z.infer<typeof BaselineContextSchema>;
export type BaselineSource = z.infer<typeof BaselineSourceSchema>;
export type TraceSurface = z.infer<typeof TraceSurfaceSchema>;
export type GroupedTrace = z.infer<typeof GroupedTraceSchema>;
export type TraceSpan = z.infer<typeof TraceSpanSchema>;
export type MetricsSurface = z.infer<typeof MetricsSurfaceSchema>;
export type MetricGroup = z.infer<typeof MetricGroupSchema>;
export type MetricGroupKey = z.infer<typeof MetricGroupKeySchema>;
export type MetricRow = z.infer<typeof MetricRowSchema>;
export type LogsSurface = z.infer<typeof LogsSurfaceSchema>;
export type LogCluster = z.infer<typeof LogClusterSchema>;
export type LogClusterKey = z.infer<typeof LogClusterKeySchema>;
export type LogEntry = z.infer<typeof LogEntrySchema>;
export type AbsenceEvidenceEntry = z.infer<typeof AbsenceEvidenceEntrySchema>;
