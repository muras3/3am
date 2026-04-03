import type { IncidentPacket, DiagnosisResult } from "@3am/core";

// Scenario: third_party_api_rate_limit_cascade
// Flash sale traffic spike → Stripe HTTP 429 → fixed-interval retry storm →
// shared checkout worker pool exhaustion → route-wide 504s

export const packet: IncidentPacket = {
  schemaVersion: "incident-packet/v1alpha1",
  packetId: "pkt_scenario_01",
  incidentId: "inc_scenario_01",
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
    affectedServices: ["web"],
    affectedRoutes: ["/checkout", "/api/payments"],
    affectedDependencies: ["stripe"],
  },
  triggerSignals: [
    {
      signal: "HTTP 429 from stripe — x-ratelimit-remaining: 0",
      firstSeenAt: "2026-03-09T03:00:00Z",
      entity: "stripe",
    },
    {
      signal: "error_rate > 50% on /checkout",
      firstSeenAt: "2026-03-09T03:00:30Z",
      entity: "web",
    },
  ],
  evidence: {
    changedMetrics: [],
    representativeTraces: [
      {
        traceId: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
        spanId: "span_checkout_01",
        serviceName: "web",
        durationMs: 5200,
        httpStatusCode: 504,
        spanStatusCode: 2,
      },
      {
        traceId: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
        spanId: "span_stripe_01",
        serviceName: "api-gateway",
        durationMs: 3100,
        httpStatusCode: 429,
        spanStatusCode: 2,
      },
    ],
    relevantLogs: [],
    platformEvents: [],
  },
  pointers: {
    traceRefs: [
      "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
    ],
    logRefs: [],
    metricRefs: [],
    platformLogRefs: [],
  },
};

export const diagnosis: DiagnosisResult = {
  summary: {
    what_happened:
      "Flash sale traffic spike caused Stripe to return HTTP 429 (rate limit exhausted). " +
      "The application's fixed-interval retry policy re-attempted every 100ms up to 5 times, " +
      "amplifying upstream request volume 5x and saturating the 16-slot shared checkout worker pool. " +
      "Queue depth climbed and route-wide 504s appeared within 90 seconds of the first 429.",
    root_cause_hypothesis:
      "Fixed-interval retry policy against a rate-limited payment dependency exhausted " +
      "the shared checkout worker pool. The retry amplification (5 attempts × 80 rps) " +
      "generated ~400 rps against a dependency with a quota of ~100 rps.",
  },
  recommendation: {
    immediate_action:
      "Disable fixed retries on the Stripe client immediately (set max_attempts=0 or 1) " +
      "and apply exponential backoff with jitter. If the worker pool remains saturated, " +
      "temporarily reduce max_rps on the checkout route.",
    action_rationale_short:
      "Disabling retries stops the amplification loop fastest — " +
      "Stripe quota recovers within seconds once inbound volume drops.",
    do_not:
      "Do not restart application instances — restart does not change retry behaviour and " +
      "re-warms the worker pool while queue remains full. " +
      "Do not increase Stripe rate-limit quota without first fixing the retry policy.",
  },
  reasoning: {
    causal_chain: [
      {
        type: "external",
        title: "Stripe rate limit hit",
        detail:
          "Flash sale doubled checkout rps from 8 to ~80. Stripe returned HTTP 429 " +
          "with x-ratelimit-remaining: 0 and retry-after: 1.",
      },
      {
        type: "system",
        title: "Fixed-interval retry storm",
        detail:
          "App retried every 100ms × 5 attempts, generating ~400 concurrent Stripe calls " +
          "and holding each worker slot for up to 5 × 100ms = 500ms per request.",
      },
      {
        type: "incident",
        title: "Worker pool saturation",
        detail:
          "All 16 checkout workers occupied. Incoming requests queued; queue_depth rose linearly. " +
          "Spans show queue_wait_ms exceeding 4s before the 5s timeout.",
      },
      {
        type: "impact",
        title: "Route-wide 504s",
        detail:
          "Queued requests hit the 30s application timeout. /checkout and /api/payments both " +
          "started returning 504s. Checkout error rate exceeded 50%.",
      },
    ],
  },
  operator_guidance: {
    watch_items: [
      {
        label: "Stripe 429 rate",
        state: "must reach 0 before re-enabling retries",
        status: "alert",
      },
      {
        label: "Worker pool utilisation",
        state: "must drop below 80% to confirm recovery",
        status: "watch",
      },
      {
        label: "Queue depth",
        state: "must flatten within 60s of disabling retries",
        status: "watch",
      },
    ],
    operator_checks: [
      "Confirm Stripe x-ratelimit-remaining > 0 before re-enabling retries",
      "Verify queue_depth metric flattens within 60s of config change",
      "Check worker_pool_in_use drops below 8 within 2 minutes",
      "Review Stripe dashboard for quota headroom before the next flash sale",
    ],
  },
  confidence: {
    confidence_assessment:
      "High confidence. HTTP 429 signals, retry attempt logs, worker_pool_in_use saturation, " +
      "and the timing correlation between flash sale start and first 429 all converge on a single causal path.",
    uncertainty:
      "Stripe's current quota ceiling is not visible in telemetry. " +
      "If the quota was already near-exhausted before the flash sale, " +
      "the trigger may have been any traffic spike, not specifically this one.",
  },
  metadata: {
    incident_id: "inc_scenario_01",
    packet_id: "pkt_scenario_01",
    model: "claude-sonnet-4-6",
    prompt_version: "v5",
    created_at: "2026-03-09T03:01:00Z",
  },
};
