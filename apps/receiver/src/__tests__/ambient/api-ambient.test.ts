import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { IncidentPacket } from "@3am/core";
import { MemoryAdapter } from "../../storage/adapters/memory.js";
import { createApp } from "../../index.js";
import { SpanBuffer } from "../../ambient/span-buffer.js";
import type { BufferedSpan } from "../../ambient/types.js";
import { MemoryTelemetryAdapter } from "../../telemetry/adapters/memory.js";
import { spanMembershipKey } from "../../storage/interface.js";

function makeBufferedSpan(overrides: Partial<BufferedSpan> = {}): BufferedSpan {
  return {
    traceId: "trace1",
    spanId: "span1",
    serviceName: "api",
    environment: "production",
    spanStatusCode: 1,
    durationMs: 100,
    startTimeMs: 1700000000000,
    exceptionCount: 0,
    ingestedAt: Date.now(),
    ...overrides,
  };
}

function makeIncidentPacket(overrides: Partial<IncidentPacket> = {}): IncidentPacket {
  return {
    schemaVersion: "incident-packet/v1alpha1",
    packetId: "pkt_001",
    incidentId: "inc_000001",
    openedAt: new Date("2026-04-08T00:00:00.000Z").toISOString(),
    window: {
      start: new Date("2026-04-07T23:50:00.000Z").toISOString(),
      detect: new Date("2026-04-07T23:55:00.000Z").toISOString(),
      end: new Date("2026-04-08T00:00:00.000Z").toISOString(),
    },
    scope: {
      environment: "production",
      primaryService: "api",
      affectedServices: ["api"],
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
    ...overrides,
  };
}

describe("Ambient API routes", () => {
  let storage: MemoryAdapter;

  beforeEach(() => {
    delete process.env["RECEIVER_AUTH_TOKEN"];
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    storage = new MemoryAdapter();
  });

  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
  });

  // ── GET /api/services ─────────────────────────────────────────────────────────

  it("GET /api/services: spanBuffer not provided → returns []", async () => {
    // createApp without spanBuffer (backward compat)
    const app = createApp(storage);
    const res = await app.request("/api/services");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("GET /api/services: spanBuffer provided, no spans pushed → returns []", async () => {
    const spanBuffer = new SpanBuffer();
    const app = createApp(storage, { spanBuffer });
    const res = await app.request("/api/services");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("GET /api/services: spanBuffer with spans → returns services", async () => {
    const spanBuffer = new SpanBuffer();
    spanBuffer.push(makeBufferedSpan({ serviceName: "web", spanId: "s1" }));
    spanBuffer.push(makeBufferedSpan({ serviceName: "web", spanId: "s2" }));
    spanBuffer.push(makeBufferedSpan({ serviceName: "api", spanId: "s3" }));
    const app = createApp(storage, { spanBuffer });
    const res = await app.request("/api/services");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ name: string }>;
    const names = body.map((s) => s.name);
    expect(names).toContain("web");
    expect(names).toContain("api");
  });

  it("GET /api/services: falls back to telemetry store when spanBuffer is absent", async () => {
    const telemetryStore = new MemoryTelemetryAdapter();
    const now = Date.now();
    await telemetryStore.ingestSpans([
      {
        traceId: "trace-1",
        spanId: "span-1",
        serviceName: "checkout",
        environment: "production",
        spanName: "GET /checkout",
        spanStatusCode: 1,
        durationMs: 120,
        startTimeMs: now - 30_000,
        exceptionCount: 0,
        attributes: {},
        ingestedAt: now,
      },
    ]);

    const app = createApp(storage, { telemetryStore });
    const res = await app.request("/api/services");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ name: string }>;
    expect(body.map((service) => service.name)).toContain("checkout");
  });

  // ── GET /api/activity ─────────────────────────────────────────────────────────

  it("GET /api/activity: spanBuffer not provided → returns []", async () => {
    const app = createApp(storage);
    const res = await app.request("/api/activity");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("GET /api/activity: falls back to preserved incident spans when live telemetry window is empty", async () => {
    const telemetryStore = new MemoryTelemetryAdapter();
    const span = {
      traceId: "trace-fallback",
      spanId: "span-fallback",
      serviceName: "api",
      environment: "production",
      spanName: "POST /checkout",
      httpRoute: "/checkout",
      httpStatusCode: 500,
      spanStatusCode: 2,
      durationMs: 6400,
      startTimeMs: Date.now() - 10 * 60_000,
      exceptionCount: 1,
      attributes: {},
      ingestedAt: Date.now() - 10 * 60_000,
    };
    await telemetryStore.ingestSpans([span]);
    await storage.createIncident(
      makeIncidentPacket(),
      {
        telemetryScope: {
          windowStartMs: span.startTimeMs - 1_000,
          windowEndMs: span.startTimeMs + 1_000,
          detectTimeMs: span.startTimeMs,
          environment: "production",
          memberServices: ["api"],
          dependencyServices: [],
        },
        spanMembership: [spanMembershipKey(span.traceId, span.spanId)],
        anomalousSignals: [],
      },
    );

    const app = createApp(storage, { telemetryStore });
    const res = await app.request("/api/activity");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ service: string; traceId: string; anomalous: boolean }>;
    expect(body).toEqual([
      expect.objectContaining({
        service: "api",
        traceId: "trace-fallback",
        anomalous: true,
      }),
    ]);
  });

  it("GET /api/activity?limit=5: returns at most 5 items", async () => {
    const spanBuffer = new SpanBuffer();
    for (let i = 0; i < 10; i++) {
      spanBuffer.push(makeBufferedSpan({ spanId: `s${i}`, startTimeMs: 1700000000000 + i }));
    }
    const app = createApp(storage, { spanBuffer });
    const res = await app.request("/api/activity?limit=5");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body.length).toBe(5);
  });

  it("GET /api/activity?limit=0: limit clamped to 1", async () => {
    const spanBuffer = new SpanBuffer();
    spanBuffer.push(makeBufferedSpan({ spanId: "s1" }));
    spanBuffer.push(makeBufferedSpan({ spanId: "s2" }));
    const app = createApp(storage, { spanBuffer });
    const res = await app.request("/api/activity?limit=0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body.length).toBe(1);
  });

  it("GET /api/activity?limit=200: limit clamped to 100", async () => {
    const spanBuffer = new SpanBuffer();
    // Push 110 spans
    for (let i = 0; i < 110; i++) {
      spanBuffer.push(makeBufferedSpan({ spanId: `s${i}`, startTimeMs: 1700000000000 + i }));
    }
    const app = createApp(storage, { spanBuffer });
    const res = await app.request("/api/activity?limit=200");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body.length).toBe(100);
  });

  it("GET /api/activity: default limit is 20", async () => {
    const spanBuffer = new SpanBuffer();
    for (let i = 0; i < 15; i++) {
      spanBuffer.push(makeBufferedSpan({ spanId: `s${i}`, startTimeMs: 1700000000000 + i }));
    }
    const app = createApp(storage, { spanBuffer });
    const res = await app.request("/api/activity");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    // 15 spans pushed, default limit 20 → all 15 returned
    expect(body.length).toBe(15);
  });

  // ── Backward compatibility ────────────────────────────────────────────────────

  it("GET /api/incidents still returns 200 (backward compat)", async () => {
    const spanBuffer = new SpanBuffer();
    const app = createApp(storage, { spanBuffer });
    const res = await app.request("/api/incidents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toBeDefined();
  });
});
