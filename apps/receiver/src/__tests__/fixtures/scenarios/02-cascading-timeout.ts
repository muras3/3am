import type { IncidentPacket, DiagnosisResult } from "@3am/core";

// Scenario: cascading_timeout_downstream_dependency
// notification-svc latency spikes 100ms → 8s →
// synchronous calls hold all 16 shared worker slots →
// /checkout (no notification dependency) also gets 504s

export const packet: IncidentPacket = {
  schemaVersion: "incident-packet/v1alpha1",
  packetId: "pkt_scenario_02",
  incidentId: "inc_scenario_02",
  openedAt: "2026-03-09T05:00:00Z",
  status: "open",
  signalSeverity: "critical",
  window: {
    start: "2026-03-09T04:55:00Z",
    detect: "2026-03-09T05:00:00Z",
    end: "2026-03-09T05:05:00Z",
  },
  scope: {
    environment: "production",
    primaryService: "web",
    affectedServices: ["web", "notification-service"],
    affectedRoutes: ["/checkout", "/api/orders"],
    affectedDependencies: ["notification-service"],
  },
  triggerSignals: [
    {
      signal: "notification-service p99 latency 100ms → 8000ms",
      firstSeenAt: "2026-03-09T05:00:00Z",
      entity: "notification-service",
    },
    {
      signal: "worker_pool_in_use saturated at 16/16",
      firstSeenAt: "2026-03-09T05:00:08Z",
      entity: "web",
    },
  ],
  evidence: {
    changedMetrics: [],
    representativeTraces: [
      {
        traceId: "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6",
        spanId: "span_orders_01",
        serviceName: "web",
        durationMs: 8200,
        httpStatusCode: 504,
        spanStatusCode: 2,
      },
      {
        traceId: "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6",
        spanId: "span_notification_01",
        serviceName: "notification-service",
        durationMs: 8100,
        spanStatusCode: 2,
      },
    ],
    relevantLogs: [],
    platformEvents: [],
  },
  pointers: {
    traceRefs: [
      "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6",
      "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1",
    ],
    logRefs: [],
    metricRefs: [],
    platformLogRefs: [],
  },
};

export const diagnosis: DiagnosisResult = {
  summary: {
    what_happened:
      "notification-service latency spiked from 100ms to 8s. " +
      "Because /api/orders calls notification-svc synchronously inside the shared worker pool, " +
      "each worker was held for 8s. All 16 slots filled within 2 seconds of the spike. " +
      "/checkout — which has no notification dependency — also began returning 504s because " +
      "it queues in the same worker pool.",
    root_cause_hypothesis:
      "Synchronous notification calls inside a shared, bounded worker pool create a " +
      "resource-coupling between /api/orders and /checkout. A latency spike in any " +
      "downstream service that is called synchronously from the pool starves all routes, " +
      "not just the ones with the dependency.",
  },
  recommendation: {
    immediate_action:
      "Add a 500ms hard timeout on the notification-svc HTTP client call. " +
      "If notification-svc is still slow, move the call to an async queue " +
      "(fire-and-forget or job queue) so the worker slot is released immediately.",
    action_rationale_short:
      "A short client timeout frees the worker slot in 500ms instead of 8s, " +
      "reducing steady-state pool occupancy by 16x and unblocking /checkout within seconds.",
    do_not:
      "Do not increase the worker pool size as the first action — " +
      "it only delays saturation without fixing the root coupling. " +
      "Do not restart notification-svc instances without diagnosing why latency spiked.",
  },
  reasoning: {
    causal_chain: [
      {
        type: "external",
        title: "notification-svc latency spike",
        detail:
          "notification-svc p99 latency increased from 100ms to 8000ms. " +
          "Root cause of the spike is upstream to this incident (network partition or DB lock in notification-svc).",
      },
      {
        type: "system",
        title: "Shared worker pool resource coupling",
        detail:
          "/api/orders calls notification-svc synchronously. " +
          "Each call holds the worker slot for the full 8s duration. " +
          "16 concurrent /api/orders requests fill all 16 slots.",
      },
      {
        type: "incident",
        title: "/checkout queue starvation",
        detail:
          "/checkout shares the same worker pool. With all 16 slots occupied, " +
          "incoming /checkout requests queue behind /api/orders and time out at 30s. " +
          "Traces show /checkout spans with zero notification child spans, " +
          "confirming pool starvation — not a notification dependency issue.",
      },
      {
        type: "impact",
        title: "Route-wide 504s across unrelated routes",
        detail:
          "Both /api/orders (8200ms) and /checkout (504) fail. " +
          "/health returns 200 because it bypasses the worker pool. " +
          "External observers see a checkout outage with no obvious cause.",
      },
    ],
  },
  operator_guidance: {
    watch_items: [
      {
        label: "notification-svc p99 latency",
        state: "must return to <200ms for pool to drain",
        status: "alert",
      },
      {
        label: "worker_pool_in_use",
        state: "must drop below 8/16 after timeout is applied",
        status: "watch",
      },
      {
        label: "/checkout 504 rate",
        state: "should clear within 30s of pool draining",
        status: "watch",
      },
    ],
    operator_checks: [
      "Confirm notification-svc is healthy before removing timeout workaround",
      "Verify /checkout 504 rate returns to zero after worker pool drains",
      "Check that /health stays green throughout — if it degrades, suspect node-level resource exhaustion",
      "Post-incident: separate checkout worker pool from order worker pool",
    ],
  },
  confidence: {
    confidence_assessment:
      "High confidence. Traces show /checkout 504s with no notification child span, " +
      "definitively proving pool starvation rather than a notification dependency in checkout. " +
      "worker_pool_in_use saturation timeline matches notification-svc latency onset.",
    uncertainty:
      "Root cause of the notification-svc latency spike itself is unknown — " +
      "it may be an upstream DB issue or an internal bug. " +
      "Investigation of notification-svc internals is required separately.",
  },
  metadata: {
    incident_id: "inc_scenario_02",
    packet_id: "pkt_scenario_02",
    model: "claude-sonnet-4-6",
    prompt_version: "v5",
    created_at: "2026-03-09T05:01:00Z",
  },
};
