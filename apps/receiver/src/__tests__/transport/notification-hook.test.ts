/**
 * Integration tests for notification hook in ingest.ts.
 *
 * Verifies that notifyIncidentCreated is called for new incidents
 * and NOT called for existing-attach path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryAdapter } from "../../storage/adapters/memory.js";
import { createApp } from "../../index.js";

// Mock the notification module
vi.mock("../../notification/index.js", () => ({
  notifyIncidentCreated: vi.fn(),
}));

import { notifyIncidentCreated } from "../../notification/index.js";
const mockNotify = vi.mocked(notifyIncidentCreated);

// Minimal OTLP payload that triggers incident creation (error span)
function makeErrorPayload(traceId: string, spanId: string) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "web" } },
            { key: "deployment.environment.name", value: { stringValue: "production" } },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId,
                name: "GET /api/test",
                startTimeUnixNano: "1741392000000000000",
                endTimeUnixNano: "1741392000500000000",
                status: { code: 2 },
                attributes: [
                  { key: "http.route", value: { stringValue: "/api/test" } },
                  { key: "http.response.status_code", value: { intValue: 500 } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("notification hook in ingest", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("calls notifyIncidentCreated for new incident", async () => {
    const storage = new MemoryAdapter();
    const app = createApp(storage);

    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeErrorPayload("trace_notify_001", "span_notify_001")),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { incidentId?: string };
    expect(body.incidentId).toBeDefined();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0]![2]).toBe(body.incidentId);
  });

  it("does NOT call notifyIncidentCreated for existing-attach path", async () => {
    const storage = new MemoryAdapter();
    const app = createApp(storage);

    // First request creates the incident
    const res1 = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeErrorPayload("trace_notify_010", "span_notify_010")),
    });
    expect(res1.status).toBe(200);
    expect(mockNotify).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();

    // Second request with same formation key attaches to existing incident
    const res2 = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeErrorPayload("trace_notify_011", "span_notify_011")),
    });
    expect(res2.status).toBe(200);

    // Notification should NOT be called for the attach path
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("ingest returns 200 even if notification throws", async () => {
    mockNotify.mockRejectedValue(new Error("notification boom"));

    const storage = new MemoryAdapter();
    const app = createApp(storage);

    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeErrorPayload("trace_notify_020", "span_notify_020")),
    });

    // ingest should still succeed because notification is fire-and-forget (void)
    expect(res.status).toBe(200);
  });
});
