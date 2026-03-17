import type { Incident, TelemetrySpan, TelemetryMetric, TelemetryLog } from "../api/types.js";
import type {
  DiagnosisResult,
  IncidentPacket,
  ExtractedSpan,
  PlatformEvent,
  RelevantLog,
  ChangedMetric,
} from "@3amoncall/core";

export const testPacket: IncidentPacket = {
  schemaVersion: "incident-packet/v1alpha1",
  packetId: "pkt_test_001",
  incidentId: "inc_test_001",
  openedAt: "2026-03-09T03:00:00Z",
  status: "open",
  signalSeverity: "critical",
  window: {
    start: "2026-03-09T02:55:00Z",
    detect: "2026-03-09T03:00:00Z",
    end: "2026-03-09T03:05:00Z",
  },
  scope: {
    environment: "production",
    primaryService: "web",
    affectedServices: ["web", "api-gateway"],
    affectedRoutes: ["/checkout", "/api/payments"],
    affectedDependencies: ["stripe"],
  },
  triggerSignals: [
    {
      signal: "HTTP 429",
      firstSeenAt: "2026-03-09T03:00:12Z",
      entity: "stripe",
    },
    {
      signal: "error_rate > 50%",
      firstSeenAt: "2026-03-09T03:00:45Z",
      entity: "web",
    },
  ],
  evidence: {
    changedMetrics: [],
    representativeTraces: [
      {
        traceId: "abc123def456",
        spanId: "span_001_abcdef",
        serviceName: "web",
        durationMs: 5200,
        httpStatusCode: 429,
        spanStatusCode: 2,
      },
      {
        traceId: "abc123def456",
        spanId: "span_002_ghijkl",
        serviceName: "api-gateway",
        durationMs: 3100,
        spanStatusCode: 0,
      },
    ],
    relevantLogs: [],
    platformEvents: [],
  },
  pointers: {
    traceRefs: ["abc123def456"],
    logRefs: [],
    metricRefs: [],
    platformLogRefs: [],
  },
};

export const testDiagnosis: DiagnosisResult = {
  summary: {
    what_happened:
      "Stripe API rate limiting caused cascading checkout failures across web and api-gateway services",
    root_cause_hypothesis:
      "Flash sale traffic exceeded Stripe rate limits, triggering 429 responses",
  },
  recommendation: {
    immediate_action:
      "Enable circuit breaker on Stripe client and activate queued retry with exponential backoff",
    action_rationale_short:
      "Reduces blast radius by preventing retry storms and preserving checkout for non-Stripe flows",
    do_not:
      "Do not increase Stripe API concurrency or disable rate limiting protections",
  },
  reasoning: {
    causal_chain: [
      {
        type: "external",
        title: "Stripe rate limit hit",
        detail: "429 responses from Stripe payments API",
      },
      {
        type: "system",
        title: "Retry storms",
        detail: "Unthrottled retries amplify load 3x",
      },
      {
        type: "incident",
        title: "Checkout failures",
        detail: "Payment processing blocked for all users",
      },
      {
        type: "impact",
        title: "Revenue loss",
        detail: "Estimated 40% checkout drop during flash sale",
      },
    ],
  },
  operator_guidance: {
    watch_items: [
      { label: "Error rate", state: "52%", status: "alert" },
      { label: "Stripe 429s", state: "rising", status: "watch" },
      { label: "Queue depth", state: "0", status: "ok" },
    ],
    operator_checks: [
      "Verify circuit breaker state in config",
      "Check Stripe dashboard for quota increase options",
    ],
  },
  confidence: {
    confidence_assessment: "High confidence based on clear 429 correlation",
    uncertainty:
      "Unknown whether Stripe has automatic quota recovery within the hour",
  },
  metadata: {
    incident_id: "inc_test_001",
    packet_id: "pkt_test_001",
    model: "claude-sonnet-4-6",
    prompt_version: "v5",
    created_at: "2026-03-09T03:01:00Z",
  },
};

export const testIncident: Incident = {
  incidentId: "inc_test_001",
  status: "open",
  openedAt: "2026-03-09T03:00:00Z",
  packet: testPacket,
  diagnosisResult: testDiagnosis,
};

export const testIncidentNoDiagnosis: Incident = {
  incidentId: "inc_test_002",
  status: "open",
  openedAt: "2026-03-09T03:00:00Z",
  packet: testPacket,
};

// ── v4 fixtures ──────────────────────────────────────────────

export const testSpan1: ExtractedSpan = {
  traceId: "trace_001",
  spanId: "span_root_001",
  serviceName: "web",
  environment: "production",
  httpRoute: "/checkout",
  httpMethod: "POST",
  httpStatusCode: 429,
  spanStatusCode: 2,
  spanKind: 2,
  durationMs: 5200,
  startTimeMs: 1741485600000,
  exceptionCount: 1,
  spanName: "POST /checkout",
};

export const testSpan2: ExtractedSpan = {
  traceId: "trace_001",
  spanId: "span_child_002",
  parentSpanId: "span_root_001",
  serviceName: "stripe",
  environment: "production",
  httpRoute: "/v1/charges",
  httpMethod: "POST",
  httpStatusCode: 429,
  spanStatusCode: 2,
  spanKind: 3,
  durationMs: 5100,
  startTimeMs: 1741485600050,
  exceptionCount: 0,
  peerService: "stripe",
};

export const testSpan3: ExtractedSpan = {
  traceId: "trace_002",
  spanId: "span_root_003",
  serviceName: "api-gateway",
  environment: "production",
  httpRoute: "/api/payments",
  httpStatusCode: 200,
  spanStatusCode: 0,
  durationMs: 120,
  startTimeMs: 1741485601000,
  exceptionCount: 0,
};

// ── TelemetryStore-typed fixtures ────────────────────────────

export const testTelemetrySpan1: TelemetrySpan = {
  traceId: "trace_001",
  spanId: "span_root_001",
  serviceName: "web",
  environment: "production",
  spanName: "POST /checkout",
  httpRoute: "/checkout",
  httpMethod: "POST",
  httpStatusCode: 429,
  spanStatusCode: 2,
  spanKind: 2,
  durationMs: 5200,
  startTimeMs: 1741485600000,
  exceptionCount: 1,
  attributes: {},
  ingestedAt: 1741485610000,
};

export const testTelemetrySpan2: TelemetrySpan = {
  traceId: "trace_001",
  spanId: "span_child_002",
  parentSpanId: "span_root_001",
  serviceName: "stripe",
  environment: "production",
  spanName: "POST /v1/charges",
  httpRoute: "/v1/charges",
  httpMethod: "POST",
  httpStatusCode: 429,
  spanStatusCode: 2,
  spanKind: 3,
  durationMs: 5100,
  startTimeMs: 1741485600050,
  exceptionCount: 0,
  peerService: "stripe",
  attributes: {},
  ingestedAt: 1741485610000,
};

export const testTelemetrySpan3: TelemetrySpan = {
  traceId: "trace_002",
  spanId: "span_root_003",
  serviceName: "api-gateway",
  environment: "production",
  spanName: "GET /api/payments",
  httpRoute: "/api/payments",
  httpStatusCode: 200,
  spanStatusCode: 0,
  durationMs: 120,
  startTimeMs: 1741485601000,
  exceptionCount: 0,
  attributes: {},
  ingestedAt: 1741485610000,
};

export const testTelemetryMetric1: TelemetryMetric = {
  name: "http_server_request_duration",
  service: "web",
  environment: "production",
  startTimeMs: 1741485600000,
  summary: { asDouble: 5200.0 },
  ingestedAt: 1741485610000,
};

export const testTelemetryMetric2: TelemetryMetric = {
  name: "stripe_request_count",
  service: "web",
  environment: "production",
  startTimeMs: 1741485600000,
  summary: { count: 100, sum: 429 },
  ingestedAt: 1741485610000,
};

export const testTelemetryLog1: TelemetryLog = {
  service: "web",
  environment: "production",
  timestamp: "2026-03-09T03:00:12Z",
  startTimeMs: 1741485612000,
  severity: "ERROR",
  severityNumber: 17,
  body: "Stripe API returned 429 Too Many Requests",
  bodyHash: "abc123",
  attributes: { "http.status_code": 429, "stripe.endpoint": "/v1/charges" },
  traceId: "trace_001",
  spanId: "span_root_001",
  ingestedAt: 1741485620000,
};

export const testTelemetryLog2: TelemetryLog = {
  service: "api-gateway",
  environment: "production",
  timestamp: "2026-03-09T03:00:45Z",
  startTimeMs: 1741485645000,
  severity: "WARN",
  severityNumber: 13,
  body: "Checkout retry storm detected",
  bodyHash: "def456",
  attributes: {},
  ingestedAt: 1741485650000,
};

export const testPlatformEvent1: PlatformEvent = {
  eventId: "evt_deploy_001",
  eventType: "deploy",
  timestamp: "2026-03-09T02:58:00Z",
  environment: "production",
  description: "Deployed web service v1.2.3",
  service: "web",
};

export const testPlatformEvent2: PlatformEvent = {
  eventId: "evt_provider_001",
  eventType: "provider_incident",
  timestamp: "2026-03-09T02:59:00Z",
  environment: "production",
  description: "Stripe API degraded performance",
  provider: "stripe",
};

export const testLog1: RelevantLog = {
  service: "web",
  environment: "production",
  timestamp: "2026-03-09T03:00:12Z",
  startTimeMs: 1741485612000,
  severity: "ERROR",
  body: "Stripe API returned 429 Too Many Requests",
  attributes: { "http.status_code": 429, "stripe.endpoint": "/v1/charges" },
};

export const testLog2: RelevantLog = {
  service: "api-gateway",
  environment: "production",
  timestamp: "2026-03-09T03:00:45Z",
  startTimeMs: 1741485645000,
  severity: "WARN",
  body: "Checkout retry storm detected",
  attributes: {},
};

export const testMetric1: ChangedMetric = {
  name: "http_server_request_duration",
  service: "web",
  environment: "production",
  startTimeMs: 1741485600000,
  summary: { asDouble: 5200.0 },
};

export const testMetric2: ChangedMetric = {
  name: "stripe_request_count",
  service: "web",
  environment: "production",
  startTimeMs: 1741485600000,
  summary: { count: 100, sum: 429 },
};
