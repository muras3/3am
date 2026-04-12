import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiRouter } from "../../transport/api.js";
import { MemoryAdapter } from "../../storage/adapters/memory.js";
import { createEmptyTelemetryScope, type InitialMembership } from "../../storage/interface.js";
import type { TelemetryStoreDriver } from "../../telemetry/interface.js";
import type { DiagnosisResult, IncidentPacket } from "3am-core";

function makeTelemetryStore(): TelemetryStoreDriver {
  return {
    ingestSpans: async () => undefined,
    ingestMetrics: async () => undefined,
    ingestLogs: async () => undefined,
    querySpans: async () => [],
    queryMetrics: async () => [],
    queryLogs: async () => [],
    upsertSnapshot: async () => undefined,
    getSnapshots: async () => [],
    deleteSnapshots: async () => undefined,
    deleteExpired: async () => undefined,
  };
}

const minimalDiagnosis: DiagnosisResult = {
  summary: {
    what_happened: "Checkout calls are timing out on Stripe requests.",
    root_cause_hypothesis: "Stripe 429 responses are exhausting the checkout timeout budget.",
  },
  recommendation: {
    immediate_action: "Disable the Stripe retry loop.",
    action_rationale_short: "Reduce repeated pressure on the dependency.",
    do_not: "Do not increase the timeout budget.",
  },
  reasoning: {
    causal_chain: [
      { type: "external", title: "Stripe 429", detail: "Rate limited" },
      { type: "impact", title: "Checkout 504", detail: "User-visible failure" },
    ],
  },
  operator_guidance: {
    watch_items: [],
    operator_checks: ["Confirm the 429 burst in Stripe telemetry."],
  },
  confidence: {
    confidence_assessment: "High confidence",
    uncertainty: "Stripe internal quotas are not directly visible.",
  },
  metadata: {
    incident_id: "",
    packet_id: "pkt_test",
    model: "claude-haiku-4-5-20251001",
    prompt_version: "v5",
    created_at: new Date().toISOString(),
  },
};

function makePacket(id: string): IncidentPacket {
  return {
    schemaVersion: "incident-packet/v1alpha1",
    packetId: `pkt_${id}`,
    incidentId: id,
    openedAt: "2026-03-20T14:23:15Z",
    status: "open",
    window: {
      start: "2026-03-20T14:23:15Z",
      detect: "2026-03-20T14:23:15Z",
      end: "2026-03-20T14:24:15Z",
    },
    scope: {
      environment: "production",
      primaryService: "checkout",
      affectedServices: ["checkout"],
      affectedRoutes: ["/checkout"],
      affectedDependencies: ["stripe"],
    },
    triggerSignals: [],
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
  };
}

function makeMembership(): InitialMembership {
  return {
    telemetryScope: {
      ...createEmptyTelemetryScope(),
      windowStartMs: Date.parse("2026-03-20T14:23:15Z"),
      windowEndMs: Date.parse("2026-03-20T14:24:15Z"),
      detectTimeMs: Date.parse("2026-03-20T14:23:15Z"),
      environment: "production",
      memberServices: ["checkout"],
      dependencyServices: ["stripe"],
    },
    spanMembership: [],
    anomalousSignals: [],
  };
}

describe("POST /api/incidents/:id/close", () => {
  beforeEach(() => {
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
  });

  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
  });

  it("closes an open incident", async () => {
    const storage = new MemoryAdapter();
    const incidentId = "inc_close_001";
    await storage.createIncident(makePacket(incidentId), makeMembership());
    await storage.appendDiagnosis(incidentId, {
      ...minimalDiagnosis,
      metadata: { ...minimalDiagnosis.metadata, incident_id: incidentId, packet_id: `pkt_${incidentId}` },
    });
    const app = createApiRouter(storage, undefined, makeTelemetryStore(), { generationThreshold: 0 });

    const res = await app.request(`/api/incidents/${incidentId}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; closedAt: string };
    expect(body.status).toBe("closed");
    expect(body.closedAt).toBeTruthy();
    expect((await storage.getIncident(incidentId))?.status).toBe("closed");
  });

  it("returns the existing closedAt when the incident is already closed", async () => {
    const storage = new MemoryAdapter();
    const incidentId = "inc_close_002";
    await storage.createIncident(makePacket(incidentId), makeMembership());
    await storage.updateIncidentStatus(incidentId, "closed");
    const closedAt = (await storage.getIncident(incidentId))?.closedAt;
    const app = createApiRouter(storage, undefined, makeTelemetryStore(), { generationThreshold: 0 });

    const res = await app.request(`/api/incidents/${incidentId}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "closed", closedAt });
  });
});
