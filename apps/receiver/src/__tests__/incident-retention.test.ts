import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../index.js";
import { MemoryAdapter } from "../storage/adapters/memory.js";
import { MemoryTelemetryAdapter } from "../telemetry/adapters/memory.js";
import { createEmptyTelemetryScope, type InitialMembership } from "../storage/interface.js";
import { _resetCleanupTimerForTest } from "../retention/lazy-cleanup.js";
import type { IncidentPacket } from "@3amoncall/core";

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

describe("incident retention cleanup", () => {
  beforeEach(() => {
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    process.env["RETENTION_HOURS"] = "1";
    _resetCleanupTimerForTest();
  });

  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    delete process.env["RETENTION_HOURS"];
    _resetCleanupTimerForTest();
  });

  it("auto-closes open incidents whose last activity is older than retention", async () => {
    const storage = new MemoryAdapter();
    const telemetryStore = new MemoryTelemetryAdapter();
    const app = createApp(storage, { telemetryStore });
    const incidentId = "inc_auto_close";

    await storage.createIncident(makePacket(incidentId), makeMembership());
    await storage.touchIncidentActivity(incidentId, "2000-01-01T00:00:00Z");

    const res = await app.request("/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resourceMetrics: [] }),
    });

    expect(res.status).toBe(200);
    const incident = await storage.getIncident(incidentId);
    expect(incident?.status).toBe("closed");
    expect(incident?.closedAt).toBeTruthy();
  });

  it("hard-deletes closed incidents after the same retention window", async () => {
    const storage = new MemoryAdapter();
    const telemetryStore = new MemoryTelemetryAdapter();
    const app = createApp(storage, { telemetryStore });
    const incidentId = "inc_hard_delete";

    await storage.createIncident(makePacket(incidentId), makeMembership());
    await storage.updateIncidentStatus(incidentId, "closed");
    const incident = await storage.getIncident(incidentId);
    if (!incident) throw new Error("seed incident missing");
    incident.closedAt = "2000-01-01T00:00:00Z";

    const res = await app.request("/v1/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resourceLogs: [] }),
    });

    expect(res.status).toBe(200);
    expect(await storage.getIncident(incidentId)).toBeNull();
  });
});
