/**
 * Unit tests for otlp-protobuf.ts decode functions.
 *
 * These tests encode known OTLP structures into protobuf binary using the
 * generated Buf schemas, then verify that decode functions produce the
 * plain-object shape expected by extractSpans() / metrics / logs handlers.
 */
import { describe, it, expect } from "vitest";
import { encodeLogsRequest, encodeMetricsRequest, encodeTraceRequest } from "../fixtures/otlp-proto.js";
import { decodeLogs, decodeMetrics, decodeTraces } from "../../transport/otlp-protobuf.js";

describe("decodeTraces", () => {
  it("decodes a trace request and returns resourceSpans array", () => {
    const buf = encodeTraceRequest({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "svc-a" } },
              { key: "deployment.environment.name", value: { stringValue: "production" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "a3ce929d0e0e47364bf92f3577b34da6",
                  spanId: "00f067aa0ba902b7",
                  name: "GET /api/test",
                  startTimeUnixNano: "1741392000000000000",
                  endTimeUnixNano: "1741392000100000000",
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
    });

    const result = decodeTraces(buf) as {
      resourceSpans: {
        resource: { attributes: { key: string; value: { stringValue?: string } }[] };
        scopeSpans: { spans: { traceId: string; spanId: string; startTimeUnixNano: string; status: { code: number } }[] }[];
      }[];
    };

    expect(result.resourceSpans).toHaveLength(1);
    const rs = result.resourceSpans[0]!;
    expect(rs.resource.attributes).toContainEqual({
      key: "service.name",
      value: expect.objectContaining({ stringValue: "svc-a" }),
    });

    const span = rs.scopeSpans[0]!.spans[0]!;
    expect(span.traceId).toBe("a3ce929d0e0e47364bf92f3577b34da6");
    expect(span.spanId).toBe("00f067aa0ba902b7");
    expect(span.status.code).toBe(2);
  });

  it("converts parentSpanId from bytes to hex", () => {
    const buf = encodeTraceRequest({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "a3ce929d0e0e47364bf92f3577b34da6",
                  spanId: "00f067aa0ba902b7",
                  parentSpanId: "11a067bb0ca903c8",
                  startTimeUnixNano: "1741392000000000000",
                  endTimeUnixNano: "1741392000100000000",
                },
              ],
            },
          ],
        },
      ],
    });

    const result = decodeTraces(buf) as {
      resourceSpans: { scopeSpans: { spans: { parentSpanId: string }[] }[] }[];
    };
    const span = result.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.parentSpanId).toBe("11a067bb0ca903c8");
  });

  it("converts startTimeUnixNano to string", () => {
    const buf = encodeTraceRequest({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "00000000000000000000000000000000",
                  spanId: "0000000000000000",
                  startTimeUnixNano: "1741392000000000000",
                  endTimeUnixNano: "1741392000100000000",
                },
              ],
            },
          ],
        },
      ],
    });

    const result = decodeTraces(buf) as {
      resourceSpans: { scopeSpans: { spans: { startTimeUnixNano: unknown }[] }[] }[];
    };
    const nano = result.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.startTimeUnixNano;
    expect(typeof nano).toBe("string");
    expect(nano).toBe("1741392000000000000");
  });

  it("throws on invalid protobuf binary", () => {
    expect(() => decodeTraces(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow();
  });

  it("returns empty resourceSpans array for an empty request", () => {
    const buf = encodeTraceRequest({ resourceSpans: [] });
    const result = decodeTraces(buf) as { resourceSpans: unknown[] };
    expect(Array.isArray(result.resourceSpans)).toBe(true);
    expect(result.resourceSpans).toHaveLength(0);
  });
});

describe("decodeMetrics", () => {
  it("decodes a metrics request and returns resourceMetrics array", () => {
    const buf = encodeMetricsRequest({
      resourceMetrics: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "svc-b" } }],
          },
          scopeMetrics: [],
        },
      ],
    });

    const result = decodeMetrics(buf) as { resourceMetrics: unknown[] };
    expect(Array.isArray(result.resourceMetrics)).toBe(true);
    expect(result.resourceMetrics).toHaveLength(1);
  });

  it("accepts empty resourceMetrics array", () => {
    const buf = encodeMetricsRequest({ resourceMetrics: [] });
    const result = decodeMetrics(buf) as { resourceMetrics: unknown[] };
    expect(result.resourceMetrics).toHaveLength(0);
  });

  it("throws on invalid protobuf binary", () => {
    expect(() => decodeMetrics(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow();
  });
});

describe("decodeLogs", () => {
  it("decodes a logs request and returns resourceLogs array", () => {
    const buf = encodeLogsRequest({
      resourceLogs: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "svc-c" } }],
          },
          scopeLogs: [],
        },
      ],
    });

    const result = decodeLogs(buf) as { resourceLogs: unknown[] };
    expect(Array.isArray(result.resourceLogs)).toBe(true);
    expect(result.resourceLogs).toHaveLength(1);
  });

  it("accepts empty resourceLogs array", () => {
    const buf = encodeLogsRequest({ resourceLogs: [] });
    const result = decodeLogs(buf) as { resourceLogs: unknown[] };
    expect(result.resourceLogs).toHaveLength(0);
  });

  it("throws on invalid protobuf binary", () => {
    expect(() => decodeLogs(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow();
  });
});
