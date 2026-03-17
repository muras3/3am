/**
 * lazy-migration.ts — Shared lazy migration helpers for DJ-6 backward compatibility.
 *
 * Both PostgresAdapter and SQLiteAdapter use these functions to derive
 * telemetryScope/spanMembership/anomalousSignals/platformEvents from
 * legacy rawState + packet data when the new columns are NULL.
 */
import type { IncidentPacket, PlatformEvent } from "@3amoncall/core";
import type { AnomalousSignal, TelemetryScope } from "../interface.js";
import { spanMembershipKey } from "../interface.js";

export interface LegacyRawState {
  spans?: Array<{ traceId: string; spanId: string }>;
  anomalousSignals?: AnomalousSignal[];
  platformEvents?: PlatformEvent[];
}

export function deriveTelemetryScopeFromPacket(packet: IncidentPacket): TelemetryScope {
  return {
    windowStartMs: new Date(packet.window.start).getTime(),
    windowEndMs: new Date(packet.window.end).getTime(),
    detectTimeMs: new Date(packet.window.detect).getTime(),
    environment: packet.scope.environment,
    memberServices: [...packet.scope.affectedServices],
    dependencyServices: [...packet.scope.affectedDependencies],
  };
}

export function deriveSpanMembershipFromRawState(rawState: LegacyRawState | null): string[] {
  if (!rawState?.spans) return [];
  return rawState.spans.map(s => spanMembershipKey(s.traceId, s.spanId));
}

export function deriveAnomalousSignalsFromRawState(rawState: LegacyRawState | null): AnomalousSignal[] {
  return rawState?.anomalousSignals ?? [];
}

export function derivePlatformEventsFromRawState(
  rawState: LegacyRawState | null,
  packet: IncidentPacket,
): PlatformEvent[] {
  return rawState?.platformEvents ?? packet.evidence.platformEvents ?? [];
}
