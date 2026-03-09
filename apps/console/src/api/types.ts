export type { IncidentPacket, DiagnosisResult, CausalChainStep } from "@3amoncall/core";

export interface Incident {
  incidentId: string;
  status: "open" | "closed";
  openedAt: string;
  closedAt?: string;
  packet: import("@3amoncall/core").IncidentPacket;
  diagnosisResult?: import("@3amoncall/core").DiagnosisResult;
}

export interface IncidentPage {
  items: Incident[];
  nextCursor?: string;
}
