import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryAdapter } from "../../storage/adapters/memory.js";
import { createApp } from "../../index.js";
import { SpanBuffer } from "../../ambient/span-buffer.js";
import type { BufferedSpan } from "../../ambient/types.js";

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

  // ── GET /api/activity ─────────────────────────────────────────────────────────

  it("GET /api/activity: spanBuffer not provided → returns []", async () => {
    const app = createApp(storage);
    const res = await app.request("/api/activity");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
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
