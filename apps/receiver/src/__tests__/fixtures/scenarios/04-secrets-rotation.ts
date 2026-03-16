import type { IncidentPacket, DiagnosisResult } from "@3amoncall/core";

// Scenario: secrets_rotation_partial_propagation
// API key rotated: key_v2 deployed to new instances but old instances still use key_v1.
// Stripe/SendGrid revokes key_v1 → 401 Unauthorized on old deployment.
// New deployment succeeds → partial failure pattern with deployment skew.

export const packet: IncidentPacket = {
  schemaVersion: "incident-packet/v1alpha1",
  packetId: "pkt_scenario_04",
  incidentId: "inc_scenario_04",
  openedAt: "2026-03-09T09:00:00Z",
  status: "open",
  signalSeverity: "critical",
  window: {
    start: "2026-03-09T08:55:00Z",
    detect: "2026-03-09T09:00:00Z",
    end: "2026-03-09T09:05:00Z",
  },
  scope: {
    environment: "production",
    primaryService: "api-gateway",
    affectedServices: ["api-gateway"],
    affectedRoutes: ["/api/payments"],
    affectedDependencies: ["stripe"],
  },
  triggerSignals: [
    {
      signal: "HTTP 401 Unauthorized from stripe — authorization grant is invalid, expired, or revoked",
      firstSeenAt: "2026-03-09T09:00:00Z",
      entity: "stripe",
    },
    {
      signal: "partial failure: dpl_old 401 rate 100%, dpl_new success rate 100%",
      firstSeenAt: "2026-03-09T09:00:05Z",
      entity: "api-gateway",
    },
  ],
  evidence: {
    changedMetrics: [],
    representativeTraces: [
      {
        traceId: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
        spanId: "span_old_deployment_01",
        serviceName: "api-gateway",
        durationMs: 1200,
        httpStatusCode: 401,
        spanStatusCode: 2,
      },
      {
        traceId: "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6",
        spanId: "span_new_deployment_01",
        serviceName: "api-gateway",
        durationMs: 800,
        httpStatusCode: 200,
        spanStatusCode: 0,
      },
    ],
    relevantLogs: [],
    platformEvents: [],
  },
  pointers: {
    traceRefs: [
      "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
      "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6",
    ],
    logRefs: [],
    metricRefs: [],
    platformLogRefs: [],
  },
};

export const diagnosis: DiagnosisResult = {
  summary: {
    what_happened:
      "An API key rotation was performed: key_v2 was injected into new deployment instances (dpl_new) " +
      "but old instances (dpl_old) were not restarted and continue using the revoked key_v1. " +
      "Stripe/SendGrid revoked key_v1 immediately upon rotation. " +
      "50% of /api/payments requests (those load-balanced to dpl_old) now return 401. " +
      "The other 50% (dpl_new) succeed. /health returns 200 on all instances.",
    root_cause_hypothesis:
      "Partial secrets propagation: key_v1 revoked but still active in old deployment instances. " +
      "The deployment strategy did not perform a rolling restart of existing instances " +
      "after the secret was rotated, leaving dpl_old with stale credentials.",
  },
  recommendation: {
    immediate_action:
      "Force a rolling restart of all api-gateway instances (dpl_old) to pick up the new key_v2 " +
      "from the secrets store. In Vercel/CF: redeploy or run 'vercel redeploy --force'. " +
      "Verify 401 rate drops to zero within 60s of restart.",
    action_rationale_short:
      "A rolling restart forces dpl_old to re-read the secrets store and load key_v2, " +
      "unifying credentials across all instances without downtime.",
    do_not:
      "Do not revoke key_v2 — it is the valid key used by currently healthy instances. " +
      "Do not roll back the key rotation; key_v1 was intentionally revoked.",
  },
  reasoning: {
    causal_chain: [
      {
        type: "external",
        title: "API key rotated at secrets store",
        detail:
          "key_v1 revoked, key_v2 activated. New deployments pick up key_v2 via env injection. " +
          "Old running instances retain key_v1 in memory.",
      },
      {
        type: "system",
        title: "Deployment skew: two active key versions",
        detail:
          "dpl_new instances: key_v2 → Stripe accepts → HTTP 200. " +
          "dpl_old instances: key_v1 → Stripe rejects → HTTP 401. " +
          "Load balancer distributes traffic to both, creating a 50% failure rate.",
      },
      {
        type: "incident",
        title: "401 errors on /api/payments (partial)",
        detail:
          "Requests routed to dpl_old fail with 401 'authorization grant is invalid'. " +
          "Requests routed to dpl_new succeed. Error rate is deployment-dependent, not random.",
      },
      {
        type: "impact",
        title: "Customer-visible payment failures",
        detail:
          "~50% of payment attempts fail. Customers see checkout errors intermittently. " +
          "The partial pattern makes this harder to detect via aggregate error rate alone.",
      },
    ],
  },
  operator_guidance: {
    watch_items: [
      {
        label: "dpl_old 401 rate",
        state: "must reach 0 after rolling restart",
        status: "alert",
      },
      {
        label: "dpl_new success rate",
        state: "must remain 100% throughout restart",
        status: "ok",
      },
      {
        label: "/api/payments aggregate error rate",
        state: "must drop from ~50% to <1% after restart",
        status: "watch",
      },
    ],
    operator_checks: [
      "Confirm X-Deployment-ID header in traces to identify which instances are still failing",
      "Trigger rolling restart of all api-gateway instances",
      "Verify 401 rate on /api/payments reaches zero within 90s of restart",
      "Post-incident: add secrets rotation runbook requiring forced instance restart",
    ],
  },
  confidence: {
    confidence_assessment:
      "High confidence. The partial failure pattern (100% failure on dpl_old, 0% on dpl_new) " +
      "combined with a recent key rotation event uniquely identifies deployment skew as the cause. " +
      "No alternative explanation produces this exact split.",
    uncertainty:
      "It is unclear whether the secrets rotation procedure was manual or automated. " +
      "If automated, the pipeline may need a post-rotation restart step. " +
      "Stripe quota or network issues are ruled out given dpl_new success rate.",
  },
  metadata: {
    incident_id: "inc_scenario_04",
    packet_id: "pkt_scenario_04",
    model: "claude-sonnet-4-6",
    prompt_version: "v5",
    created_at: "2026-03-09T09:01:00Z",
  },
};
