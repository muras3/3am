export type { IncidentPacket, DiagnosisResult, CausalChainStep } from "@3amoncall/core";

import type { IncidentPacket, DiagnosisResult } from "@3amoncall/core";

export interface Incident {
  incidentId: string;
  status: "open" | "closed";
  openedAt: string;
  closedAt?: string;
  packet: IncidentPacket;
  diagnosisResult?: DiagnosisResult;
}

export interface IncidentPage {
  items: Incident[];
  nextCursor?: string;
}

export interface ServiceSurface {
  name: string;
  health: "healthy" | "degraded" | "critical";
  reqPerSec: number;
  p95Ms: number;
  errorRate: number;
  trend: number[];
}

export interface RecentActivity {
  ts: number;
  service: string;
  route: string;
  httpStatus?: number;
  durationMs: number;
  traceId: string;
  anomalous: boolean;
}
