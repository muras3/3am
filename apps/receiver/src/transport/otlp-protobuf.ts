/**
 * OTLP protobuf decode utilities (ADR 0022: protobuf is first-class transport).
 *
 * Decodes OTLP/HTTP protobuf binary bodies into plain JS objects compatible
 * with the existing extractSpans() / metrics / logs handlers.
 *
 * Proto source: opentelemetry-proto v1.3.2
 * Generated via: `pnpm proto:gen`
 */
import { fromBinary, toJson, type JsonWriteOptions } from "@bufbuild/protobuf";
import { normalizeIdToHex } from "../domain/otlp-utils.js";
import { ExportLogsServiceRequestSchema } from "./proto/gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js";
import { ExportMetricsServiceRequestSchema } from "./proto/gen/opentelemetry/proto/collector/metrics/v1/metrics_service_pb.js";
import { ExportTraceServiceRequestSchema } from "./proto/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";

const JSON_OPTIONS: JsonWriteOptions = {
  alwaysEmitImplicit: true,
  enumAsInteger: true,
  useProtoFieldName: false,
};

function normalizeSpanIds(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(normalizeSpanIds);

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (
      (key === "traceId" || key === "spanId" || key === "parentSpanId") &&
      typeof val === "string"
    ) {
      result[key] = normalizeIdToHex(val);
    } else {
      result[key] = normalizeSpanIds(val);
    }
  }
  return result;
}

/**
 * Decode an OTLP ExportTraceServiceRequest protobuf binary into a plain object
 * compatible with extractSpans() (i.e. `{ resourceSpans: [...] }`).
 */
export function decodeTraces(buf: Uint8Array): unknown {
  const decoded = fromBinary(ExportTraceServiceRequestSchema, buf);
  const plain = toJson(ExportTraceServiceRequestSchema, decoded, JSON_OPTIONS);
  return normalizeSpanIds(plain);
}

/**
 * Decode an OTLP ExportMetricsServiceRequest protobuf binary.
 * Returns `{ resourceMetrics: [...] }`.
 */
export function decodeMetrics(buf: Uint8Array): unknown {
  const decoded = fromBinary(ExportMetricsServiceRequestSchema, buf);
  return toJson(ExportMetricsServiceRequestSchema, decoded, JSON_OPTIONS);
}

/**
 * Decode an OTLP ExportLogsServiceRequest protobuf binary.
 * Returns `{ resourceLogs: [...] }`.
 */
export function decodeLogs(buf: Uint8Array): unknown {
  const decoded = fromBinary(ExportLogsServiceRequestSchema, buf);
  return toJson(ExportLogsServiceRequestSchema, decoded, JSON_OPTIONS);
}
