import type { Incident } from "../api/types.js";
import type { DiagnosisResult, IncidentPacket } from "@3amoncall/core";

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
