import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock credentials module
vi.mock("../commands/init/credentials.js", () => ({
  resolveApiKey: vi.fn(),
  loadCredentials: vi.fn(() => ({})),
  saveCredentials: vi.fn(),
}));

import { resolveApiKey } from "../commands/init/credentials.js";
import { runDemo, buildDemoPayload } from "../commands/demo.js";

// ---------------------------------------------------------------------------
// buildDemoPayload
// ---------------------------------------------------------------------------

describe("buildDemoPayload()", () => {
  it("returns OTLP JSON with 3amoncall-demo service", () => {
    const payload = buildDemoPayload() as {
      resourceSpans: Array<{
        resource: {
          attributes: Array<{ key: string; value: { stringValue: string } }>;
        };
        scopeSpans: Array<{ spans: unknown[] }>;
      }>;
    };

    expect(payload.resourceSpans).toHaveLength(1);

    const resource = payload.resourceSpans[0]!.resource;
    const serviceName = resource.attributes.find(
      (a) => a.key === "service.name",
    );
    expect(serviceName?.value.stringValue).toBe("3amoncall-demo");

    const env = resource.attributes.find(
      (a) => a.key === "deployment.environment.name",
    );
    expect(env?.value.stringValue).toBe("demo");
  });

  it("contains 2 spans in the same trace", () => {
    const payload = buildDemoPayload() as {
      resourceSpans: Array<{
        scopeSpans: Array<{
          spans: Array<{ traceId: string; spanId: string; parentSpanId?: string }>;
        }>;
      }>;
    };

    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(2);

    // Same trace
    expect(spans[0]!.traceId).toBe(spans[1]!.traceId);

    // Child references parent
    expect(spans[1]!.parentSpanId).toBe(spans[0]!.spanId);
  });

  it("spans have anomaly-triggering attributes", () => {
    const payload = buildDemoPayload() as {
      resourceSpans: Array<{
        scopeSpans: Array<{
          spans: Array<{
            status: { code: number };
            attributes: Array<{
              key: string;
              value: { intValue?: number; stringValue?: string };
            }>;
          }>;
        }>;
      }>;
    };

    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
    for (const span of spans) {
      // OTel ERROR status
      expect(span.status.code).toBe(2);
      // HTTP 504
      const httpStatus = span.attributes.find(
        (a) => a.key === "http.response.status_code",
      );
      expect(httpStatus?.value.intValue).toBe(504);
    }
  });

  it("generates unique IDs on each call", () => {
    const p1 = buildDemoPayload() as {
      resourceSpans: Array<{
        scopeSpans: Array<{ spans: Array<{ traceId: string }> }>;
      }>;
    };
    const p2 = buildDemoPayload() as typeof p1;
    expect(p1.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId).not.toBe(
      p2.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId,
    );
  });
});

// ---------------------------------------------------------------------------
// runDemo
// ---------------------------------------------------------------------------

describe("runDemo()", () => {
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    stdoutChunks = [];
    stderrChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("exits with error when no API key", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue(undefined);

    await runDemo([], { noInteractive: true });

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderrChunks.join("")).toContain("ANTHROPIC_API_KEY is required");
  });

  it("exits with error when Receiver is not running", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue("sk-test");
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await runDemo([], { noInteractive: true, yes: true });

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderrChunks.join("")).toContain("Receiver is not running");
  });

  it("requires cost consent in non-interactive mode without --yes", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue("sk-test");
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });

    await runDemo([], { noInteractive: true });

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderrChunks.join("")).toContain("cost consent required");
  });

  it("sends demo traces and polls for diagnosis", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue("sk-test");

    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        const urlStr = String(url);
        // Receiver health check
        if (urlStr.includes("/api/incidents?limit=1")) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        // Trace ingest
        if (urlStr.includes("/v1/traces") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              status: "ok",
              incidentId: "inc_demo_123",
              packetId: "pkt_demo_123",
            }),
            { status: 200 },
          );
        }
        // Poll for diagnosis — return result immediately
        if (urlStr.includes("/api/incidents/inc_demo_123")) {
          return new Response(
            JSON.stringify({
              incidentId: "inc_demo_123",
              diagnosisResult: { summary: { what_happened: "test" } },
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      });

    await runDemo([], { noInteractive: true, yes: true });

    const stdout = stdoutChunks.join("");
    expect(stdout).toContain("Incident created");
    expect(stdout).toContain("inc_demo_123");
    expect(stdout).toContain("Diagnosis complete");
    expect(stdout).toContain("http://localhost:3333");
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("handles ingest failure gracefully", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue("sk-test");

    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/incidents?limit=1")) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        if (urlStr.includes("/v1/traces") && init?.method === "POST") {
          return new Response("internal error", { status: 500 });
        }
        return new Response("not found", { status: 404 });
      });

    await runDemo([], { noInteractive: true, yes: true });

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderrChunks.join("")).toContain("failed to send demo traces");
  });

  it("handles missing incidentId in response", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue("sk-test");

    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/incidents?limit=1")) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        if (urlStr.includes("/v1/traces") && init?.method === "POST") {
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
          });
        }
        return new Response("not found", { status: 404 });
      });

    await runDemo([], { noInteractive: true, yes: true });

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderrChunks.join("")).toContain("did not create an incident");
  });

  it("shows demo metadata in output", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue("sk-test");

    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/incidents?limit=1")) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        if (urlStr.includes("/v1/traces") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              status: "ok",
              incidentId: "inc_demo_456",
              packetId: "pkt_demo_456",
            }),
            { status: 200 },
          );
        }
        if (urlStr.includes("/api/incidents/inc_demo_456")) {
          return new Response(
            JSON.stringify({
              incidentId: "inc_demo_456",
              diagnosisResult: { summary: {} },
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      });

    await runDemo([], { noInteractive: true, yes: true });

    const stdout = stdoutChunks.join("");
    expect(stdout).toContain("downstream timeout cascade");
    expect(stdout).toContain("3amoncall-demo");
    expect(stdout).toContain("demo");
    expect(stdout).toContain("won't appear in production");
  });

  it("sends correct OTLP payload to Receiver", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue("sk-test");

    let capturedBody: string | undefined;
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/incidents?limit=1")) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        if (urlStr.includes("/v1/traces") && init?.method === "POST") {
          capturedBody = init.body as string;
          return new Response(
            JSON.stringify({
              status: "ok",
              incidentId: "inc_x",
              packetId: "pkt_x",
            }),
            { status: 200 },
          );
        }
        if (urlStr.includes("/api/incidents/inc_x")) {
          return new Response(
            JSON.stringify({
              incidentId: "inc_x",
              diagnosisResult: { summary: {} },
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      });

    await runDemo([], { noInteractive: true, yes: true });

    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody!) as {
      resourceSpans: Array<{
        resource: {
          attributes: Array<{ key: string; value: { stringValue: string } }>;
        };
      }>;
    };
    const serviceName = parsed.resourceSpans[0]!.resource.attributes.find(
      (a) => a.key === "service.name",
    );
    expect(serviceName?.value.stringValue).toBe("3amoncall-demo");
  });

  it("uses custom receiver URL when provided", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue("sk-test");

    const calledUrls: string[] = [];
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        calledUrls.push(String(url));
        const urlStr = String(url);
        if (urlStr.includes("/api/incidents?limit=1")) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        if (urlStr.includes("/v1/traces") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              status: "ok",
              incidentId: "inc_y",
              packetId: "pkt_y",
            }),
            { status: 200 },
          );
        }
        if (urlStr.includes("/api/incidents/inc_y")) {
          return new Response(
            JSON.stringify({
              incidentId: "inc_y",
              diagnosisResult: { summary: {} },
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      });

    await runDemo([], {
      noInteractive: true,
      yes: true,
      receiverUrl: "http://localhost:4444",
    });

    expect(calledUrls.some((u) => u.startsWith("http://localhost:4444"))).toBe(
      true,
    );
    expect(
      calledUrls.some((u) => u.startsWith("http://localhost:3333")),
    ).toBe(false);
  });
});
