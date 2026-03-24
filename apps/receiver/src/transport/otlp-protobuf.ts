/**
 * OTLP protobuf decode utilities (ADR 0022: protobuf is first-class transport).
 *
 * Decodes OTLP/HTTP protobuf binary bodies into plain JS objects compatible
 * with the existing extractSpans() / metrics / logs handlers.
 *
 * Proto source: opentelemetry-proto v1.3.2
 * Descriptor:   src/transport/proto/otlp.json (vendored, regenerate with `pnpm proto:gen`)
 */
import protobuf from 'protobufjs'

// Disable JIT code generation before any type resolution.
// CF Workers disallow new Function() — protobufjs falls back to generic decoders.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(protobuf.util as any).codegen.supported = false

// JSON descriptor for OTLP protobuf decoding.
// Static import works with both esbuild (wrangler) and Node.js/vitest bundlers.
import _descriptor from './proto/otlp.json' with { type: 'json' }
const descriptor = _descriptor as unknown as protobuf.INamespace

// Lazy initialization — deferred to first decode call to avoid module-load-time
// type resolution that may trigger codegen in some protobufjs versions.
let _root: protobuf.Root | null = null
let _traceType: protobuf.Type | null = null
let _metricsType: protobuf.Type | null = null
let _logsType: protobuf.Type | null = null

function initRoot(): void {
  if (_root) return
  _root = protobuf.Root.fromJSON(descriptor)
  _traceType = _root.lookupType(
    'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
  )
  _metricsType = _root.lookupType(
    'opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest',
  )
  _logsType = _root.lookupType(
    'opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest',
  )
}

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
    if ((key === 'traceId' || key === 'spanId' || key === 'parentSpanId') && typeof val === 'string') {
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
  initRoot()
  const decoded = _traceType!.decode(buf)
  const plain = _traceType!.toObject(decoded, DECODE_OPTIONS)
  return normalizeSpanIds(plain)
}

/**
 * Decode an OTLP ExportMetricsServiceRequest protobuf binary.
 * Returns `{ resourceMetrics: [...] }`.
 *
 * @throws protobuf.util.ProtocolError or Error on invalid binary.
 */
export function decodeMetrics(buf: Uint8Array): unknown {
  initRoot()
  const decoded = _metricsType!.decode(buf)
  return _metricsType!.toObject(decoded, DECODE_OPTIONS)
}

/**
 * Decode an OTLP ExportLogsServiceRequest protobuf binary.
 * Returns `{ resourceLogs: [...] }`.
 *
 * @throws protobuf.util.ProtocolError or Error on invalid binary.
 */
export function decodeLogs(buf: Uint8Array): unknown {
  initRoot()
  const decoded = _logsType!.decode(buf)
  return _logsType!.toObject(decoded, DECODE_OPTIONS)
}
