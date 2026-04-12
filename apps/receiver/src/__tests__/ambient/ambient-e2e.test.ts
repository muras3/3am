/**
 * E2E integration tests for the ambient read model (ADR 0029).
 *
 * These tests spin up the full Hono app (via app.request — no real HTTP server
 * needed for Hono fetch-compatible handlers) and exercise the round-trip:
 *   POST /v1/traces (OTLP JSON) → SpanBuffer → GET /api/services + /api/activity
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryAdapter } from "../../storage/adapters/memory.js";
import { createApp } from "../../index.js";

// ── OTLP JSON helpers ───────────────────────────────────────────────────────

function makeTraceBody(
  serviceName: string,
  httpStatusCode: number,
  durationMs: number,
  spanId: string = "span001",
  traceId: string = "trace001",
  environment: string = "test",
) {
  const startNs = BigInt(1700000000000) * 1_000_000n;
  const endNs = startNs + BigInt(durationMs) * 1_000_000n;

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: serviceName } },
            {
              key: "deployment.environment.name",
              value: { stringValue: environment },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId,
                startTimeUnixNano: startNs.toString(),
                endTimeUnixNano: endNs.toString(),
                status: { code: httpStatusCode >= 500 ? 2 : 1 },
                attributes: [
                  {
                    key: "http.route",
                    value: { stringValue: "/api/test" },
                  },
                  {
                    key: "http.response.status_code",
                    value: { intValue: httpStatusCode },
                  },
                ],
                events: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

async function postTrace(
  app: ReturnType<typeof createApp>,
  body: object,
): Promise<Response> {
  return app.request("/v1/traces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe("Ambient read model E2E", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    delete process.env["RECEIVER_AUTH_TOKEN"];
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    // createApp auto-creates a fresh SpanBuffer each time (ADR 0029)
    app = createApp(new MemoryAdapter());
  });

  afterEach(() => {
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
  });

  // ── Case 1: Initial state (no spans) ──────────────────────────────────────

  it("Case 1 — GET /api/services returns [] before any spans", async () => {
    const res = await app.request("/api/services");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("Case 1 — GET /api/activity returns [] before any spans", async () => {
    const res = await app.request("/api/activity");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  // ── Case 2: Normal span → service appears as healthy ─────────────────────

  it("Case 2 — POST normal span, GET /api/services returns service with health=healthy", async () => {
    const traceBody = makeTraceBody("web", 200, 100, "span-normal-001");
    const postRes = await postTrace(app, traceBody);
    expect(postRes.status).toBe(200);

    const res = await app.request("/api/services");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      name: string;
      health: string;
    }>;

    const webService = body.find((s) => s.name === "web");
    expect(webService).toBeDefined();
    expect(webService?.health).toBe("healthy");
  });

  // ── Case 3: Anomalous span → appears in activity with anomalous=true ──────

  it("Case 3 — POST 500 span, GET /api/services includes service", async () => {
    const traceBody = makeTraceBody("payments", 500, 200, "span-error-001");
    const postRes = await postTrace(app, traceBody);
    expect(postRes.status).toBe(200);

    const res = await app.request("/api/services");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ name: string }>;
    const names = body.map((s) => s.name);
    expect(names).toContain("payments");
  });

  it("Case 3 — POST 500 span, GET /api/activity has anomalous=true entry", async () => {
    const traceBody = makeTraceBody("payments", 500, 200, "span-error-002");
    const postRes = await postTrace(app, traceBody);
    expect(postRes.status).toBe(200);

    const res = await app.request("/api/activity");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      service: string;
      anomalous: boolean;
      httpStatus?: number;
    }>;

    expect(body.length).toBeGreaterThan(0);
    const errorEntry = body.find(
      (e) => e.service === "payments" && e.anomalous === true,
    );
    expect(errorEntry).toBeDefined();
    expect(errorEntry?.httpStatus).toBe(500);
  });

  // ── Case 4: Multiple services ─────────────────────────────────────────────

  it("Case 4 — POST spans for svc-a and svc-b, GET /api/services includes both", async () => {
    await postTrace(app, makeTraceBody("svc-a", 200, 50, "span-a-001", "trace-a-001"));
    await postTrace(app, makeTraceBody("svc-b", 200, 75, "span-b-001", "trace-b-001"));

    const res = await app.request("/api/services");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ name: string }>;
    const names = body.map((s) => s.name);
    expect(names).toContain("svc-a");
    expect(names).toContain("svc-b");
  });

  // ── Case 5: activity limit ─────────────────────────────────────────────────

  it("Case 5 — GET /api/activity?limit=3 returns only 3 items after 5 spans", async () => {
    for (let i = 0; i < 5; i++) {
      await postTrace(
        app,
        makeTraceBody("web", 200, 10 + i, `span-limit-${i}`, `trace-limit-${i}`),
      );
    }

    const res = await app.request("/api/activity?limit=3");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(3);
  });

  it("Case 5 — GET /api/activity?limit=3 returns latest-first (highest ts first)", async () => {
    // Post spans with different durations to produce distinct startTimeMs offsets;
    // we use unique startTimeUnixNano to distinguish ordering.
    // Since makeTraceBody anchors startTime to a fixed nano timestamp, we post
    // spans with spans that have increasing spanIds; the buffer sorts by startTimeMs.
    // Use a custom body with explicit timestamps to guarantee ordering.
    const base = 1700000000000n; // ms
    for (let i = 0; i < 5; i++) {
      const startNs = (base + BigInt(i) * 1000n) * 1_000_000n;
      const endNs = startNs + 10_000_000n; // 10ms
      await app.request("/v1/traces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: {
                attributes: [
                  { key: "service.name", value: { stringValue: "web" } },
                  {
                    key: "deployment.environment.name",
                    value: { stringValue: "test" },
                  },
                ],
              },
              scopeSpans: [
                {
                  spans: [
                    {
                      traceId: `trace-ord-${i}`,
                      spanId: `span-ord-${i}`,
                      startTimeUnixNano: startNs.toString(),
                      endTimeUnixNano: endNs.toString(),
                      status: { code: 1 },
                      attributes: [
                        {
                          key: "http.route",
                          value: { stringValue: "/api/test" },
                        },
                        {
                          key: "http.response.status_code",
                          value: { intValue: 200 },
                        },
                      ],
                      events: [],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });
    }

    const res = await app.request("/api/activity?limit=3");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ ts: number }>;
    expect(body).toHaveLength(3);

    // Verify latest-first: each item ts should be >= the next
    for (let i = 0; i < body.length - 1; i++) {
      expect(body[i]!.ts).toBeGreaterThanOrEqual(body[i + 1]!.ts);
    }
  });
});
