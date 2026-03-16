import { describe, it, expect } from "vitest";
import { SQLiteAdapter } from "../../storage/drizzle/sqlite.js";
import { runStorageSuite, makePacket } from "./shared-suite.js";
import type { ExtractedSpan } from "../../domain/anomaly-detector.js";

// Each test gets a fresh in-memory database via the factory function
runStorageSuite("SQLiteAdapter", () => new SQLiteAdapter(":memory:"));

// ── SQLite-specific: transaction atomicity smoke tests ────────────────────────

describe("SQLiteAdapter — transaction atomicity", () => {
  function makeSpan(id: string): ExtractedSpan {
    return {
      traceId: "trace_tx",
      spanId: id,
      serviceName: "web",
      environment: "production",
      spanStatusCode: 0,
      durationMs: 100,
      startTimeMs: 1000,
      exceptionCount: 0,
    };
  }

  it("appendSpans preserves both batches when called sequentially", async () => {
    const adapter = new SQLiteAdapter(":memory:");
    const packet = makePacket({ incidentId: "inc_tx_spans", packetId: "pkt_tx_spans" });
    await adapter.createIncident(packet);

    const batch1 = [makeSpan("span_a1"), makeSpan("span_a2")];
    const batch2 = [makeSpan("span_b1"), makeSpan("span_b2"), makeSpan("span_b3")];

    await adapter.appendSpans(packet.incidentId, batch1);
    await adapter.appendSpans(packet.incidentId, batch2);

    const rawState = await adapter.getRawState(packet.incidentId);
    expect(rawState).not.toBeNull();
    expect(rawState!.spans).toHaveLength(5);
    expect(rawState!.spans.map((s) => s.spanId)).toEqual([
      "span_a1", "span_a2", "span_b1", "span_b2", "span_b3",
    ]);
  });

  it("appendRawEvidence preserves both batches when called sequentially", async () => {
    const adapter = new SQLiteAdapter(":memory:");
    const packet = makePacket({ incidentId: "inc_tx_evidence", packetId: "pkt_tx_evidence" });
    await adapter.createIncident(packet);

    await adapter.appendRawEvidence(packet.incidentId, {
      metricEvidence: [{ name: "m1", service: "s", environment: "e", startTimeMs: 1, summary: {} }],
    });
    await adapter.appendRawEvidence(packet.incidentId, {
      metricEvidence: [{ name: "m2", service: "s", environment: "e", startTimeMs: 2, summary: {} }],
      logEvidence: [{ service: "s", environment: "e", timestamp: "t", startTimeMs: 1, severity: "ERROR", body: "b", attributes: {} }],
    });

    const rawState = await adapter.getRawState(packet.incidentId);
    expect(rawState).not.toBeNull();
    expect(rawState!.metricEvidence).toHaveLength(2);
    expect(rawState!.logEvidence).toHaveLength(1);
  });

  it("appendAnomalousSignals preserves both batches when called sequentially", async () => {
    const adapter = new SQLiteAdapter(":memory:");
    const packet = makePacket({ incidentId: "inc_tx_signals", packetId: "pkt_tx_signals" });
    await adapter.createIncident(packet);

    await adapter.appendAnomalousSignals(packet.incidentId, [
      { signal: "http_429", firstSeenAt: "2026-03-09T03:00:00Z", entity: "stripe", spanId: "s1" },
    ]);
    await adapter.appendAnomalousSignals(packet.incidentId, [
      { signal: "slow_span", firstSeenAt: "2026-03-09T03:01:00Z", entity: "web", spanId: "s2" },
    ]);

    const rawState = await adapter.getRawState(packet.incidentId);
    expect(rawState).not.toBeNull();
    expect(rawState!.anomalousSignals).toHaveLength(2);
  });

  it("appendPlatformEvents preserves both batches when called sequentially", async () => {
    const adapter = new SQLiteAdapter(":memory:");
    const packet = makePacket({ incidentId: "inc_tx_events", packetId: "pkt_tx_events" });
    await adapter.createIncident(packet);

    await adapter.appendPlatformEvents(packet.incidentId, [
      { eventType: "deploy", timestamp: "2026-03-09T03:00:00Z", environment: "production", description: "d1" },
    ]);
    await adapter.appendPlatformEvents(packet.incidentId, [
      { eventType: "provider_incident", timestamp: "2026-03-09T03:01:00Z", environment: "production", description: "d2", provider: "stripe", eventId: "evt_1" },
    ]);

    const rawState = await adapter.getRawState(packet.incidentId);
    expect(rawState).not.toBeNull();
    expect(rawState!.platformEvents).toHaveLength(2);
  });
});
