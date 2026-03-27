import { metrics, type Counter, type Histogram } from "@opentelemetry/api";

let requestCounter: Counter | null = null;
let requestDuration: Histogram | null = null;

function ensureInstruments(): { requestCounter: Counter; requestDuration: Histogram } {
  if (!requestCounter || !requestDuration) {
    const meter = metrics.getMeter("3amoncall.receiver.self");
    requestCounter = meter.createCounter("3amoncall.receiver.requests", {
      description: "Count of receiver self-instrumented HTTP requests",
    });
    requestDuration = meter.createHistogram("3amoncall.receiver.request.duration", {
      description: "Duration of receiver self-instrumented HTTP requests",
      unit: "ms",
    });
  }

  return { requestCounter, requestDuration };
}

export function recordSelfTelemetryMetrics(input: {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}): void {
  const { requestCounter, requestDuration } = ensureInstruments();
  const attributes = {
    "http.request.method": input.method,
    "http.route": input.route,
    "http.response.status_code": input.statusCode,
    "3amoncall.telemetry.stream": "self",
  };

  requestCounter.add(1, attributes);
  requestDuration.record(input.durationMs, attributes);
}
