/**
 * Curated API types — re-exported from @3amoncall/core.
 *
 * Single source of truth for receiver, diagnosis, and frontend.
 * See packages/core/src/schemas/curated-api.ts for definitions.
 */
export type {
  // Shared enums
  NodeTier,
  HealthStatus,
  EdgeKind,
  CausalStepType,
  ProofCardStatus,
  EvidenceSurface,
  ClaimType,
  SpanStatus,
  CuratedState,
  // Runtime map
  RuntimeMapResponse,
  RuntimeMapSummary,
  MapNode,
  MapEdge,
  MapIncident,
  // Extended incident
  ExtendedIncident,
  IncidentChip,
  IncidentAction,
  CausalStep,
  ImpactSummary,
  BlastRadiusEntry,
  ConfidenceSummary,
  EvidenceCounts,
  // Evidence
  EvidenceResponse,
  ProofCard,
  EvidenceRef,
  QABlock,
  EvidenceSurfaces,
  TraceSurface,
  TraceGroup,
  TraceSpan,
  CorrelatedLog,
  MetricsSurface,
  HypothesisGroup,
  HypothesisMetric,
  LogsSurface,
  LogClaim,
  LogEntry,
  SideNote,
} from "@3amoncall/core";
