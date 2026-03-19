import type { CausalChainStep } from "@3amoncall/core";
import type { TelemetrySpan } from "../../api/types.js";

// ── Evidence Studio v4 ──────────────────────────────────────

export type TabKey = "traces" | "metrics" | "logs" | "platform";

export interface SideNoteVM {
  title: string;
  text: string;
  accent: "accent" | "teal" | "amber" | "good";
}

export interface SpanDetailVM {
  spanId: string;
  spanName?: string;
  serviceName: string;
  httpRoute?: string;
  httpMethod?: string;
  httpStatusCode?: number;
  spanStatusCode: number;
  spanKind?: number;
  durationMs: number;
  startTimeMs: number;
  peerService?: string;
  exceptionCount: number;
  parentSpanId?: string;
  isAiSelected: boolean;
}

export interface SpanRowVM {
  span: TelemetrySpan;
  depth: number;
  isAiSelected: boolean;
}

export interface TraceGroupVM {
  traceId: string;
  rootSpan: TelemetrySpan;
  method?: string;
  route?: string;
  rootStatus: number;
  totalDurationMs: number;
  spanCount: number;
  orderedSpans: SpanRowVM[];
  traceStartMs: number;
}

export interface ProofCardV4VM {
  id: string;
  label: string;
  summary: string;
  evidence: string;
  targetTab: TabKey;
  targetId?: string;
  icon: string;
  iconClass: "accent" | "teal" | "amber" | "good";
  status: "confirmed" | "inferred" | "pending";
}

export interface EvidenceStudioV4VM {
  title: string;
  severity: "critical" | "warning" | "info";
  proofCards: ProofCardV4VM[];
  tabCounts: Record<TabKey, number>;
  sideNotes: SideNoteVM[];
}

export interface IncidentWorkspaceVM {
  incidentId: string;
  headline: string;
  chips: ChipVM[];
  action: ActionVM;
  cause: CauseVM;
  evidence: EvidenceEntryVM;
  timeline: ImpactTimelineVM;
  copilot: CopilotVM;
}

export interface ChipVM {
  label: string;
  kind: "critical" | "system" | "external";
}

export interface ActionVM {
  primaryText: string;        // recommendation.immediate_action
  rationale: string;          // recommendation.action_rationale_short
  doNot: string;              // recommendation.do_not
}

export interface CauseVM {
  hypothesis: string;         // summary.root_cause_hypothesis
  chain: CausalChainStep[];   // reasoning.causal_chain
}

export interface ImpactTimelineVM {
  events: Array<{ time: string; label: string }>;
  surface: string;
}

export interface EvidenceEntryVM {
  traces: number;
  metrics: number;
  logs: number;
  platformEvents: number;
  traceCount: number;
}

export interface CopilotVM {
  confidence: string;
  uncertainty: string;
  operatorCheck: string;
}
