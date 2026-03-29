import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encodeTraceRequest } from "../fixtures/otlp-proto.js";

const AUTH_HEADER = { Authorization: "Bearer workers-test-token" };

describe("Cloudflare Workers protobuf ingest", () => {
  it("accepts OTLP protobuf traces and persists the incident in D1", async () => {
    const payload = encodeTraceRequest({
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
                  traceId: "11111111111111111111111111111111",
                  spanId: "2222222222222222",
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
    });

    const ingestRes = await SELF.fetch("https://receiver.example/v1/traces", {
      method: "POST",
      headers: {
        ...AUTH_HEADER,
        "Content-Type": "application/x-protobuf",
      },
      body: payload,
    });

    expect(ingestRes.status).toBe(200);

    const incidentsRes = await SELF.fetch("https://receiver.example/api/incidents", {
      headers: AUTH_HEADER,
    });
    expect(incidentsRes.status).toBe(200);

    const page = await incidentsRes.json() as { items: Array<{ incidentId: string }> };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.incidentId).toBeTruthy();
  });
});
