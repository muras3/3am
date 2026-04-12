import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOKIE_NAME } from "../../middleware/session-cookie.js";
import { createApiRouter } from "../../transport/api.js";
import { MemoryAdapter } from "../../storage/adapters/memory.js";
import { createEmptyTelemetryScope, type InitialMembership } from "../../storage/interface.js";
import type { TelemetryStoreDriver } from "../../telemetry/interface.js";
import type { DiagnosisRunner } from "../../runtime/diagnosis-runner.js";
import type { DiagnosisResult, IncidentPacket } from "3am-core";

const TOKEN = "test-token";

function authHeader() {
  return { Authorization: `Bearer ${TOKEN}` };
}

function extractSessionCookie(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match?.[1] ?? "";
}

async function getSessionCookie(app: ReturnType<typeof createApiRouter>): Promise<string> {
  const claimRes = await app.request("/api/claims", {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: "{}",
  });
  const claimBody = await claimRes.json() as { token: string };
  const exchangeRes = await app.request("/api/claims/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: claimBody.token }),
  });
  return extractSessionCookie(exchangeRes);
}

function queryHeaders(sessionCookie: string) {
  return {
    ...authHeader(),
    Cookie: `${COOKIE_NAME}=${sessionCookie}`,
  };
}

function makeTelemetryStore(): TelemetryStoreDriver {
  return {
    ingestSpans: vi.fn(),
    ingestMetrics: vi.fn(),
    ingestLogs: vi.fn(),
    querySpans: vi.fn().mockResolvedValue([]),
    queryMetrics: vi.fn().mockResolvedValue([]),
    queryLogs: vi.fn().mockResolvedValue([]),
    getSnapshots: vi.fn().mockResolvedValue([]),
    deleteExpired: vi.fn(),
    deleteExpiredSnapshots: vi.fn(),
  } as unknown as TelemetryStoreDriver;
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

let seedCounter = 0;

function makePacket(suffix: string): IncidentPacket {
  const now = new Date().toISOString();
  return {
    schemaVersion: "incident-packet/v1alpha1",
    packetId: `pkt_${suffix}`,
    incidentId: `inc_${suffix}`,
    openedAt: now,
    window: {
      start: now,
      detect: now,
      end: now,
    },
    scope: {
      environment: "production",
      primaryService: `web-${suffix}`,
      affectedServices: [`web-${suffix}`],
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

function makeMembership(packet: IncidentPacket): InitialMembership {
  return {
    telemetryScope: {
      ...createEmptyTelemetryScope(),
      windowStartMs: Date.now() - 60_000,
      windowEndMs: Date.now(),
      detectTimeMs: Date.now() - 30_000,
      environment: packet.scope.environment,
      memberServices: [packet.scope.primaryService],
      dependencyServices: packet.scope.affectedDependencies,
    },
    spanMembership: [],
    anomalousSignals: [],
  };
}

async function seedIncident(
  storage: MemoryAdapter,
  withDiagnosis = false,
): Promise<string> {
  seedCounter += 1;
  const suffix = String(seedCounter).padStart(3, "0");
  const packet = makePacket(suffix);
  await storage.createIncident(packet, makeMembership(packet));
  const incidentId = packet.incidentId;

  if (withDiagnosis) {
    await storage.appendDiagnosis(incidentId, {
      ...minimalDiagnosis,
      metadata: { ...minimalDiagnosis.metadata, incident_id: incidentId },
    });
  }

  return incidentId;
}

function waitFor<T>(promiseFactory: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const tick = async () => {
      try {
        const value = await promiseFactory();
        if (predicate(value)) {
          resolve(value);
          return;
        }
        if (Date.now() - startedAt > 2_000) {
          reject(new Error("Timed out waiting for predicate"));
          return;
        }
        setTimeout(tick, 20);
      } catch (error) {
        reject(error);
      }
    };

    void tick();
  });
}

describe("POST /api/incidents/:id/rerun-diagnosis", () => {
  const originalAuthToken = process.env["RECEIVER_AUTH_TOKEN"];

  beforeEach(() => {
    seedCounter = 0;
    process.env["RECEIVER_AUTH_TOKEN"] = TOKEN;
  });

  afterEach(() => {
    if (originalAuthToken !== undefined) {
      process.env["RECEIVER_AUTH_TOKEN"] = originalAuthToken;
    } else {
      delete process.env["RECEIVER_AUTH_TOKEN"];
    }
  });

  it("returns 202 Accepted and starts a rerun", async () => {
    const storage = new MemoryAdapter();
    const run = vi.fn().mockResolvedValue(true);
    const app = createApiRouter(
      storage,
      undefined,
      makeTelemetryStore(),
      { generationThreshold: 0 },
      { run } as unknown as DiagnosisRunner,
    );
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncident(storage, true);

    const res = await app.request(`/api/incidents/${incidentId}/rerun-diagnosis`, {
      method: "POST",
      headers: queryHeaders(cookie),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted" });
    await waitFor(
      async () => run.mock.calls.length,
      (count) => count > 0,
    );
    expect(run).toHaveBeenCalledWith(incidentId);
  });

  it("enqueues narrative rerun when queue dispatch is configured for a stage-1-only incident", async () => {
    const storage = new MemoryAdapter();
    const enqueueDiagnosis = vi.fn().mockResolvedValue(undefined);
    const app = createApiRouter(
      storage,
      undefined,
      makeTelemetryStore(),
      { generationThreshold: 0 },
      { run: vi.fn().mockResolvedValue(true) } as unknown as DiagnosisRunner,
      enqueueDiagnosis,
    );
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncident(storage, true);

    const res = await app.request(`/api/incidents/${incidentId}/rerun-diagnosis`, {
      method: "POST",
      headers: queryHeaders(cookie),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted" });
    expect(enqueueDiagnosis).toHaveBeenCalledWith(incidentId, "narrative");
  });

  it("enqueues narrative rerun when stage 1 exists but console narrative is missing", async () => {
    const storage = new MemoryAdapter();
    const enqueueDiagnosis = vi.fn().mockResolvedValue(undefined);
    const app = createApiRouter(
      storage,
      undefined,
      makeTelemetryStore(),
      { generationThreshold: 0 },
      { run: vi.fn().mockResolvedValue(true) } as unknown as DiagnosisRunner,
      enqueueDiagnosis,
    );
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncident(storage, true);

    const res = await app.request(`/api/incidents/${incidentId}/rerun-diagnosis`, {
      method: "POST",
      headers: queryHeaders(cookie),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted" });
    expect(enqueueDiagnosis).toHaveBeenCalledWith(incidentId, "narrative");
  });

  it("returns 404 when incident does not exist", async () => {
    const storage = new MemoryAdapter();
    const app = createApiRouter(
      storage,
      undefined,
      makeTelemetryStore(),
      { generationThreshold: 0 },
      { run: vi.fn() } as unknown as DiagnosisRunner,
    );
    const cookie = await getSessionCookie(app);

    const res = await app.request("/api/incidents/inc_missing/rerun-diagnosis", {
      method: "POST",
      headers: queryHeaders(cookie),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("returns 409 when a diagnosis run is already in progress", async () => {
    const storage = new MemoryAdapter();
    const app = createApiRouter(
      storage,
      undefined,
      makeTelemetryStore(),
      { generationThreshold: 0 },
      { run: vi.fn().mockResolvedValue(true) } as unknown as DiagnosisRunner,
    );
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncident(storage, true);
    await storage.claimDiagnosisDispatch(incidentId);

    const res = await app.request(`/api/incidents/${incidentId}/rerun-diagnosis`, {
      method: "POST",
      headers: queryHeaders(cookie),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_running" });
  });

  it("moves the incident through pending and back to ready after rerun completes", async () => {
    const storage = new MemoryAdapter();
    let finishRun!: () => void;
    const run = vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => {
      finishRun = () => resolve(true);
    }));
    const app = createApiRouter(
      storage,
      undefined,
      makeTelemetryStore(),
      { generationThreshold: 0 },
      { run } as unknown as DiagnosisRunner,
    );
    const cookie = await getSessionCookie(app);
    const incidentId = await seedIncident(storage, true);

    const startRes = await app.request(`/api/incidents/${incidentId}/rerun-diagnosis`, {
      method: "POST",
      headers: queryHeaders(cookie),
    });
    expect(startRes.status).toBe(202);

    const pendingRes = await waitFor(
      async () => app.request(`/api/incidents/${incidentId}`),
      (response) => response.status === 200,
    );
    const pendingBody = await pendingRes.json() as { state: { diagnosis: string } };
    expect(pendingBody.state.diagnosis).toBe("pending");

    finishRun();

    const readyBody = await waitFor(
      async () => {
        const response = await app.request(`/api/incidents/${incidentId}`);
        return response.json() as Promise<{ state: { diagnosis: string } }>;
      },
      (body) => body.state.diagnosis === "ready",
    );

    expect(readyBody.state.diagnosis).toBe("ready");
  });
});
