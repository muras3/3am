import { create, toBinary, type DescMessage } from "@bufbuild/protobuf";
import { ExportLogsServiceRequestSchema } from "../../transport/proto/gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js";
import { ExportMetricsServiceRequestSchema } from "../../transport/proto/gen/opentelemetry/proto/collector/metrics/v1/metrics_service_pb.js";
import { ExportTraceServiceRequestSchema } from "../../transport/proto/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";

const ID_FIELDS = new Set(["traceId", "spanId", "parentSpanId"]);
const HEX_PATTERN = /^[0-9a-f]+$/i;
const ANY_VALUE_FIELDS = [
  "stringValue",
  "boolValue",
  "intValue",
  "doubleValue",
  "arrayValue",
  "kvlistValue",
  "bytesValue",
] as const;

function stringToBytes(value: string): Uint8Array {
  if (value.length % 2 === 0 && HEX_PATTERN.test(value)) {
    const bytes = new Uint8Array(value.length / 2);
    for (let i = 0; i < value.length; i += 2) {
      bytes[i / 2] = parseInt(value.slice(i, i + 2), 16);
    }
    return bytes;
  }
  return new TextEncoder().encode(value);
}

function normalizeProtoInput(value: unknown, key?: string): unknown {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== "undefined" && value instanceof Buffer) return new Uint8Array(value);
  if (typeof value === "string" && key && ID_FIELDS.has(key)) {
    return stringToBytes(value);
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeProtoInput(entry));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const oneofEntry = entries.find(([entryKey]) =>
      (ANY_VALUE_FIELDS as readonly string[]).includes(entryKey),
    );
    if (oneofEntry) {
      const [caseKey, caseValue] = oneofEntry;
      return {
        value: {
          case: caseKey,
          value: normalizeProtoInput(caseValue, caseKey),
        },
      };
    }

    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of entries) {
      result[entryKey] = normalizeProtoInput(entryValue, entryKey);
    }
    return result;
  }
  return value;
}

function encodeMessage(schema: DescMessage, value: unknown): Uint8Array {
  const normalized = normalizeProtoInput(value);
  return toBinary(schema, create(schema, normalized));
}

export function encodeTraceRequest(value: unknown): Uint8Array {
  return encodeMessage(ExportTraceServiceRequestSchema, value);
}

export function encodeMetricsRequest(value: unknown): Uint8Array {
  return encodeMessage(ExportMetricsServiceRequestSchema, value);
}

export function encodeLogsRequest(value: unknown): Uint8Array {
  return encodeMessage(ExportLogsServiceRequestSchema, value);
}
