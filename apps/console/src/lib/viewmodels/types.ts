import type { CausalChainStep } from "@3amoncall/core";

export interface IncidentWorkspaceVM {
  incidentId: string;
  headline: string;
  chips: ChipVM[];
  action: ActionVM;
  recovery: RecoveryVM;
  cause: CauseVM;
  evidence: EvidenceEntryVM;
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

export interface RecoveryVM {
  items: Array<{
    look: string;             // watch_items[].label
    means: string;            // watch_items[].state
    status: "watch" | "ok" | "alert";
  }>;
}

export interface CauseVM {
  hypothesis: string;         // summary.root_cause_hypothesis
  chain: CausalChainStep[];   // reasoning.causal_chain
}

export interface EvidenceEntryVM {
  traces: number;
  metrics: number;
  logs: number;
}

export interface EvidenceStudioVM {
  proofCards: ProofCardVM[];
  componentFlow: ComponentFlowVM;
}

export interface ProofCardVM {
  label: string;              // "External Trigger" | "Design Gap" | "Recovery Signal"
  proof: string;
  sourceFamily: string;
  detail: string;
}

export interface ComponentFlowVM {
  nodes: Array<{ id: string; label: string; role: "cause" | "spread" | "impact" }>;
  edges: Array<{ from: string; to: string }>;
}

export interface CopilotVM {
  confidence: string;
  uncertainty: string;
  operatorCheck: string;
}
