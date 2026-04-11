import {
  ConsoleNarrativeSchema,
  DiagnosisResultSchema,
  IncidentPacketSchema,
  PlatformEventSchema,
  ThinEventSchema,
} from "3am-core";
import { z } from "zod";
import type { AnomalousSignal, TelemetryScope } from "../interface.js";

const TelemetryScopeSchema = z.object({
  windowStartMs: z.number(),
  windowEndMs: z.number(),
  detectTimeMs: z.number(),
  environment: z.string(),
  memberServices: z.array(z.string()),
  dependencyServices: z.array(z.string()),
});

const AnomalousSignalSchema = z.object({
  signal: z.string(),
  firstSeenAt: z.string(),
  entity: z.string(),
  spanId: z.string(),
});

export function parseIncidentPacket(value: unknown) {
  return IncidentPacketSchema.parse(value);
}

export function parseTelemetryScope(value: unknown): TelemetryScope {
  return TelemetryScopeSchema.parse(value);
}

export function parseSpanMembership(value: unknown): string[] {
  return z.array(z.string()).parse(value);
}

export function parseAnomalousSignals(value: unknown): AnomalousSignal[] {
  return z.array(AnomalousSignalSchema).parse(value);
}

export function parsePlatformEvents(value: unknown) {
  return z.array(PlatformEventSchema).parse(value);
}

export function parseDiagnosisResult(value: unknown) {
  return DiagnosisResultSchema.parse(value);
}

export function parseConsoleNarrative(value: unknown) {
  return ConsoleNarrativeSchema.parse(value);
}

export function parseThinEvent(value: unknown) {
  return ThinEventSchema.parse(value);
}
