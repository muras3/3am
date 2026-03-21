export type {
  IncidentPacket,
  DiagnosisResult,
  ConsoleNarrative,
  CausalChainStep,
  ChangedMetric,
  RelevantLog,
  PlatformEvent,
  RepresentativeTrace,
} from "@3amoncall/core";

import type { IncidentPacket, DiagnosisResult, ConsoleNarrative } from "@3amoncall/core";

export interface Incident {
  incidentId: string;
  status: "open" | "closed";
  openedAt: string;
  closedAt?: string;
  packet: IncidentPacket;
  diagnosisResult?: DiagnosisResult;
  consoleNarrative?: ConsoleNarrative;
}

export interface IncidentPage {
  items: Incident[];
  nextCursor?: string;
}

// ── TelemetryStore row types (mirror receiver TelemetryStore shape) ──

export interface TelemetrySpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  serviceName: string;
  environment: string;
  spanName: string;
  httpRoute?: string;
  httpMethod?: string;
  httpStatusCode?: number;
  spanStatusCode: number;
  durationMs: number;
  startTimeMs: number;
  peerService?: string;
  exceptionCount: number;
  spanKind?: number;
  attributes: Record<string, unknown>;
  ingestedAt: number;
}

export interface TelemetryMetric {
  service: string;
  environment: string;
  name: string;
  startTimeMs: number;
  summary: Record<string, unknown>;
  ingestedAt: number;
}

export interface TelemetryLog {
  service: string;
  environment: string;
  timestamp: string;
  startTimeMs: number;
  severity: string;
  severityNumber: number;
  body: string;
  bodyHash: string;
  attributes: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
  ingestedAt: number;
}

export interface TelemetryLogsResponse {
  correlated: TelemetryLog[];
  contextual: TelemetryLog[];
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
