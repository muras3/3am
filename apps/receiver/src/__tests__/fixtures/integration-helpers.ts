/**
 * Shared fixtures and helpers for integration tests (SQLite, Postgres, Memory).
 *
 * Canonical OTLP payload, diagnosis fixture, and POST helper
 * used by integration-sqlite.test.ts and integration-postgres.test.ts.
 */
import { expect } from "vitest";
import type { createApp } from "../../index.js";

// Minimal OTLP payload with an error span (spanStatusCode=2, httpStatusCode=500)
export const errorSpanPayload = {
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
              traceId: "abc123",
              spanId: "span001",
              name: "POST /checkout",
              startTimeUnixNano: "1741392000000000000",
              endTimeUnixNano: "1741392000500000000",
              status: { code: 2 },
              attributes: [
                { key: "http.route", value: { stringValue: "/checkout" } },
                { key: "http.response.status_code", value: { intValue: 500 } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

export function makeDiagnosisFixture(incidentId: string) {
  return {
    summary: {
      what_happened: "Stripe 429s caused checkout 504s.",
      root_cause_hypothesis: "Fixed retries amplified the failure.",
    },
    recommendation: {
      immediate_action: "Disable fixed retries.",
      action_rationale_short: "Fastest control point.",
      do_not: "Do not restart blindly.",
    },
    reasoning: {
      causal_chain: [
        { type: "external", title: "Stripe 429", detail: "rate limit begins" },
        { type: "system", title: "Retry loop", detail: "amplifies failure" },
        { type: "incident", title: "Queue climbs", detail: "local overload" },
        { type: "impact", title: "Checkout 504", detail: "customer-visible" },
      ],
    },
    operator_guidance: {
      watch_items: [{ label: "Queue", state: "must flatten first", status: "watch" }],
      operator_checks: ["Confirm queue depth flattens within 30s"],
    },
    confidence: {
      confidence_assessment: "High confidence.",
      uncertainty: "Stripe quota not visible in telemetry.",
    },
    metadata: {
      incident_id: incidentId,
      packet_id: "pkt_test",
      model: "claude-sonnet-4-6",
      prompt_version: "v5",
      created_at: "2026-03-08T12:00:00Z",
    },
  };
}

/** POST an error span payload and return the parsed incident response. */
export async function postTraces(app: ReturnType<typeof createApp>) {
  const res = await app.request("/v1/traces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(errorSpanPayload),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { status: string; incidentId: string; packetId: string };
}
