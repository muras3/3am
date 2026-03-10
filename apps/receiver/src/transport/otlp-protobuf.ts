/**
 * OTLP protobuf decode utilities (ADR 0022: protobuf is first-class transport).
 *
 * Decodes OTLP/HTTP protobuf binary bodies into plain JS objects compatible
 * with the existing extractSpans() / metrics / logs handlers.
 *
 * Proto source: opentelemetry-proto v1.3.2
 * Descriptor:   src/transport/proto/otlp.json (vendored, regenerate with `pnpm proto:gen`)
 */
import { createRequire } from 'node:module'
import protobuf from 'protobufjs'

// JSON descriptors cannot be imported with ESM `import` assertions in all runtimes;
// createRequire is the safe cross-runtime approach (Node.js, vitest).
const _require = createRequire(import.meta.url)
const descriptor: protobuf.INamespace = _require('./proto/otlp.json')

// Initialize Root once at module load time (synchronous, no I/O after this point).
const _root = protobuf.Root.fromJSON(descriptor)

const ExportTraceServiceRequest = _root.lookupType(
  'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
)
const ExportMetricsServiceRequest = _root.lookupType(
  'opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest',
)
const ExportLogsServiceRequest = _root.lookupType(
  'opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest',
)

/**
 * Conversion options shared across all OTLP decode calls.
 *
 * - longs: String  — int64/fixed64 fields (startTimeUnixNano etc.) become strings,
 *                    matching JSON OTLP format expected by extractSpans().
 * - enums: Number  — enum fields (Span.status.code etc.) become numbers.
 * - bytes: String  — bytes fields become base64 strings; traceId/spanId are
 *                    subsequently converted to lowercase hex (see normalizeSpanIds).
 * - defaults/arrays/objects/oneofs — ensure missing repeated/map fields
 *   are populated so callers don't have to guard against undefined.
 */
const DECODE_OPTIONS: protobuf.IConversionOptions = {
  longs: String,
  enums: Number,
  bytes: String,
  defaults: true,
  arrays: true,
  objects: true,
  oneofs: true,
}

/**
 * Convert a base64-encoded bytes value (as returned by protobufjs `bytes: String`)
 * to a lowercase hex string, matching the JSON OTLP encoding for traceId/spanId
 * (OTLP spec §Bytes: https://opentelemetry.io/docs/specs/otlp/#otlphttp-request).
 */
function base64ToHex(value: unknown): string {
  if (typeof value !== 'string') return ''
  return Buffer.from(value, 'base64').toString('hex')
}

/**
 * Walk the decoded object tree and convert any `traceId` / `spanId` fields
 * from base64 (protobufjs default for bytes) to lowercase hex (OTLP JSON format).
 */
function normalizeSpanIds(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(normalizeSpanIds)
  const result: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if ((key === 'traceId' || key === 'spanId') && typeof val === 'string') {
      result[key] = base64ToHex(val)
    } else {
      result[key] = normalizeSpanIds(val)
    }
  }
  return result
}

/**
 * Decode an OTLP ExportTraceServiceRequest protobuf binary into a plain object
 * compatible with extractSpans() (i.e. `{ resourceSpans: [...] }`).
 *
 * @throws protobuf.util.ProtocolError or Error on invalid binary.
 */
export function decodeTraces(buf: Uint8Array): unknown {
  const decoded = ExportTraceServiceRequest.decode(buf)
  const plain = ExportTraceServiceRequest.toObject(decoded, DECODE_OPTIONS)
  return normalizeSpanIds(plain)
}

/**
 * Decode an OTLP ExportMetricsServiceRequest protobuf binary.
 * Returns `{ resourceMetrics: [...] }`.
 *
 * @throws protobuf.util.ProtocolError or Error on invalid binary.
 */
export function decodeMetrics(buf: Uint8Array): unknown {
  const decoded = ExportMetricsServiceRequest.decode(buf)
  return ExportMetricsServiceRequest.toObject(decoded, DECODE_OPTIONS)
}

/**
 * Decode an OTLP ExportLogsServiceRequest protobuf binary.
 * Returns `{ resourceLogs: [...] }`.
 *
 * @throws protobuf.util.ProtocolError or Error on invalid binary.
 */
export function decodeLogs(buf: Uint8Array): unknown {
  const decoded = ExportLogsServiceRequest.decode(buf)
  return ExportLogsServiceRequest.toObject(decoded, DECODE_OPTIONS)
}
