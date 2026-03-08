import { describe, it, expect, beforeEach } from "vitest";
import type { IncidentPacket, DiagnosisResult, ThinEvent } from "@3amoncall/core";
import { MemoryAdapter } from "../../storage/adapters/memory.js";

const makePacket = (
  packetId: string,
  incidentId: string,
  openedAt: string = "2026-03-08T00:00:00.000Z",
): IncidentPacket => ({
  schemaVersion: "incident-packet/v1alpha1",
  packetId,
  incidentId,
  openedAt,
  window: {
    start: openedAt,
    detect: openedAt,
    end: openedAt,
  },
  scope: {
    environment: "production",
    primaryService: "web",
    affectedServices: ["web"],
    affectedRoutes: ["/api/checkout"],
    affectedDependencies: ["stripe"],
  },
  triggerSignals: [
    {
      signal: "HTTP 429 from Stripe",
      firstSeenAt: openedAt,
      entity: "stripe",
    },
  ],
  evidence: {
    changedMetrics: [],
    representativeTraces: [],
    relevantLogs: [],
    platformEvents: [],
  },
  pointers: {
    traceRefs: [],
    logRefs: [],
    metricRefs: [],
    platformLogRefs: [],
  },
});

const makeDiagnosisResult = (incidentId: string): DiagnosisResult => ({
  summary: {
    what_happened: "Stripe rate limit cascade",
    root_cause_hypothesis: "Missing retry backoff",
  },
  recommendation: {
    immediate_action: "Disable checkout endpoint",
    action_rationale_short: "Reduce blast radius",
    do_not: "Do not retry immediately",
  },
  reasoning: {
    causal_chain: [
      { type: "external", title: "Stripe 429", detail: "Rate limit hit" },
    ],
  },
  operator_guidance: {
    watch_items: [{ label: "Error rate", state: "rising", status: "red" }],
    operator_checks: ["Check Stripe dashboard"],
  },
  confidence: {
    confidence_assessment: "high",
    uncertainty: "Low uncertainty",
  },
  metadata: {
    incident_id: incidentId,
    packet_id: "pkt_001",
    model: "claude-sonnet-4-6",
    prompt_version: "v5",
    created_at: "2026-03-08T00:01:00.000Z",
  },
});

describe("MemoryAdapter", () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  it("createIncident → getIncident returns incident with correct incidentId and packet", async () => {
    const packet = makePacket("pkt_001", "inc_001");
    await adapter.createIncident(packet);
    const incident = await adapter.getIncident("inc_001");
    expect(incident).not.toBeNull();
    expect(incident!.incidentId).toBe("inc_001");
    expect(incident!.packet.packetId).toBe("pkt_001");
    expect(incident!.status).toBe("open");
  });

  it("createIncident upsert: same incidentId with different packetId → getIncident returns new packetId", async () => {
    const packet1 = makePacket("pkt_001", "inc_001");
    const packet2 = makePacket("pkt_002", "inc_001");
    await adapter.createIncident(packet1);
    await adapter.createIncident(packet2);
    const incident = await adapter.getIncident("inc_001");
    expect(incident!.packet.packetId).toBe("pkt_002");
  });

  it("createIncident upsert preserves existing diagnosisResult", async () => {
    const packet1 = makePacket("pkt_001", "inc_001");
    await adapter.createIncident(packet1);
    const diagnosisResult = makeDiagnosisResult("inc_001");
    await adapter.appendDiagnosis("inc_001", diagnosisResult);

    const packet2 = makePacket("pkt_002", "inc_001");
    await adapter.createIncident(packet2);

    const incident = await adapter.getIncident("inc_001");
    expect(incident!.packet.packetId).toBe("pkt_002");
    expect(incident!.diagnosisResult).toBeDefined();
    expect(incident!.diagnosisResult!.summary.what_happened).toBe(
      "Stripe rate limit cascade",
    );
  });

  it("getIncident unknown id → null", async () => {
    const result = await adapter.getIncident("nonexistent");
    expect(result).toBeNull();
  });

  it("updateIncidentStatus('inc_001', 'closed') → status becomes 'closed'", async () => {
    const packet = makePacket("pkt_001", "inc_001");
    await adapter.createIncident(packet);
    await adapter.updateIncidentStatus("inc_001", "closed");
    const incident = await adapter.getIncident("inc_001");
    expect(incident!.status).toBe("closed");
    expect(incident!.closedAt).toBeDefined();
  });

  it("appendDiagnosis → getIncident shows diagnosisResult", async () => {
    const packet = makePacket("pkt_001", "inc_001");
    await adapter.createIncident(packet);
    const diagnosisResult = makeDiagnosisResult("inc_001");
    await adapter.appendDiagnosis("inc_001", diagnosisResult);
    const incident = await adapter.getIncident("inc_001");
    expect(incident!.diagnosisResult).toBeDefined();
    expect(incident!.diagnosisResult!.summary.root_cause_hypothesis).toBe(
      "Missing retry backoff",
    );
  });

  it("listIncidents({ limit: 10 }) → items has 1 incident, no nextCursor", async () => {
    const packet = makePacket("pkt_001", "inc_001");
    await adapter.createIncident(packet);
    const page = await adapter.listIncidents({ limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeUndefined();
  });

  it("listIncidents({ limit: 2 }) with 3 incidents → 2 items, nextCursor defined", async () => {
    await adapter.createIncident(
      makePacket("pkt_001", "inc_001", "2026-03-08T00:00:00.000Z"),
    );
    await adapter.createIncident(
      makePacket("pkt_002", "inc_002", "2026-03-08T00:01:00.000Z"),
    );
    await adapter.createIncident(
      makePacket("pkt_003", "inc_003", "2026-03-08T00:02:00.000Z"),
    );
    const page = await adapter.listIncidents({ limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeDefined();
  });

  it("listIncidents with cursor from previous call → remaining items", async () => {
    await adapter.createIncident(
      makePacket("pkt_001", "inc_001", "2026-03-08T00:00:00.000Z"),
    );
    await adapter.createIncident(
      makePacket("pkt_002", "inc_002", "2026-03-08T00:01:00.000Z"),
    );
    await adapter.createIncident(
      makePacket("pkt_003", "inc_003", "2026-03-08T00:02:00.000Z"),
    );
    const page1 = await adapter.listIncidents({ limit: 2 });
    const page2 = await adapter.listIncidents({
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
  });

  it("deleteExpiredIncidents(cutoffDate) deletes closed incidents with openedAt before cutoff", async () => {
    await adapter.createIncident(
      makePacket("pkt_001", "inc_001", "2026-03-07T00:00:00.000Z"),
    );
    await adapter.createIncident(
      makePacket("pkt_002", "inc_002", "2026-03-09T00:00:00.000Z"),
    );
    await adapter.updateIncidentStatus("inc_001", "closed");
    await adapter.updateIncidentStatus("inc_002", "closed");

    const cutoff = new Date("2026-03-08T00:00:00.000Z");
    await adapter.deleteExpiredIncidents(cutoff);

    expect(await adapter.getIncident("inc_001")).toBeNull();
    expect(await adapter.getIncident("inc_002")).not.toBeNull();
  });

  it("saveThinEvent + listThinEvents → event is retrieved", async () => {
    const event: ThinEvent = {
      event_id: "evt_001",
      event_type: "incident.created",
      incident_id: "inc_001",
      packet_id: "pkt_001",
    };
    await adapter.saveThinEvent(event);
    const events = await adapter.listThinEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_id).toBe("evt_001");
  });
});
