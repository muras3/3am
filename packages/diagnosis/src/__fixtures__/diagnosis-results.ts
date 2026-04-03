/**
 * DiagnosisResult fixtures matching the 5 validation scenarios + 1 sparse case.
 * These represent stage 1 output that stage 2 reads.
 */
import type { DiagnosisResult } from "@3am/core";

export const rateLimit: DiagnosisResult = {
  summary: {
    what_happened: "Stripe API rate limit (429) cascade caused 68% checkout failures. Fixed-interval retries in checkout-orchestrator exhausted the shared 16-worker pool, propagating 504s to all orchestrated routes.",
    root_cause_hypothesis: "checkout-orchestrator retries 429s at fixed 100ms intervals with no backoff. During 3x traffic surge, this exceeded the payment API rate limit and saturated the worker pool.",
  },
  recommendation: {
    immediate_action: "Enable exponential backoff with jitter on payment API retries and add a circuit breaker to checkout-orchestrator.",
    action_rationale_short: "Fastest control point to reduce blast radius. Backoff + circuit breaker stops retry fan-out.",
    do_not: "Do not restart the database or roll back recent deploys — the fault is in the retry logic, not infrastructure.",
  },
  reasoning: {
    causal_chain: [
      { type: "external", title: "Payment API 429", detail: "Rate limit hit at 14:23:15" },
      { type: "system", title: "Fixed-interval retries", detail: "100ms retries without backoff amplify call volume" },
      { type: "incident", title: "Worker pool exhaustion", detail: "16 workers saturated, queue depth grows" },
      { type: "impact", title: "68% checkout 504s", detail: "All orchestrated routes fail" },
    ],
  },
  operator_guidance: {
    watch_items: [{ label: "Queue depth", state: "must flatten first", status: "watch" }],
    operator_checks: ["Verify backoff config in checkout-orchestrator", "Check payment API rate limit headers", "Confirm worker pool recovery after fix"],
  },
  confidence: {
    confidence_assessment: "High confidence — 429 errors correlate directly with traffic volume (r=0.97). Worker pool saturation is observable.",
    uncertainty: "Payment provider quota bucket behavior is not visible in our telemetry.",
  },
  metadata: { incident_id: "inc_rate_limit", packet_id: "pkt_rate_limit", model: "claude-sonnet-4.6", prompt_version: "v5", created_at: "2026-03-20T14:27:45Z" },
};

export const cascadingTimeout: DiagnosisResult = {
  summary: {
    what_happened: "Slow notification-svc calls (100ms→8s) occupied all 16 worker pool slots via /api/orders, causing /checkout (unrelated to notification-svc) to queue and timeout with 504.",
    root_cause_hypothesis: "Shared worker pool with no isolation. Slow notification-svc calls in /api/orders held all slots, starving /checkout.",
  },
  recommendation: {
    immediate_action: "Add per-route worker pool isolation or make notification-svc calls async.",
    action_rationale_short: "Prevents slow downstream from starving unrelated routes.",
    do_not: "Do not investigate /checkout code — it has no bug. The issue is pool sharing.",
  },
  reasoning: {
    causal_chain: [
      { type: "external", title: "notification-svc slowdown", detail: "p99 100ms→8s" },
      { type: "system", title: "Shared worker pool", detail: "No isolation between routes" },
      { type: "incident", title: "Pool exhaustion", detail: "16 slots held by /api/orders" },
      { type: "impact", title: "/checkout 504s", detail: "Unrelated route starved" },
    ],
  },
  operator_guidance: {
    watch_items: [{ label: "Worker pool slots", state: "all 16 occupied", status: "critical" }],
    operator_checks: ["Verify notification-svc recovery", "Check /health endpoint (should be 200 — bypasses pool)"],
  },
  confidence: {
    confidence_assessment: "High confidence — /health returns 200 throughout, confirming pool exhaustion not service crash.",
    uncertainty: "Root cause of notification-svc slowdown is external and not visible.",
  },
  metadata: { incident_id: "inc_cascading_timeout", packet_id: "pkt_cascading_timeout", model: "claude-sonnet-4.6", prompt_version: "v5", created_at: "2026-03-20T14:33:00Z" },
};

export const dbMigrationLock: DiagnosisResult = {
  summary: {
    what_happened: "DDL migration acquired ACCESS EXCLUSIVE lock on orders table for 39s. Blocked db.query held the sole worker pool slot, cascading 504s to all DB-bound routes.",
    root_cause_hypothesis: "Migration had no lock_timeout set. Single blocked query monopolized the worker pool for 39 seconds.",
  },
  recommendation: {
    immediate_action: "Set lock_timeout on migration sessions and add worker pool queue timeout.",
    action_rationale_short: "Prevents future migrations from monopolizing the worker pool.",
    do_not: "Do not scale the database — the issue is lock contention, not DB capacity.",
  },
  reasoning: {
    causal_chain: [
      { type: "external", title: "DDL migration", detail: "ACCESS EXCLUSIVE lock on orders" },
      { type: "system", title: "No lock_timeout", detail: "Query blocks for full 39s" },
      { type: "incident", title: "Worker pool monopolized", detail: "Single blocked query holds slot" },
      { type: "impact", title: "All DB routes 504", detail: "Instantaneous onset and recovery" },
    ],
  },
  operator_guidance: {
    watch_items: [{ label: "Lock duration", state: "39s hold", status: "critical" }],
    operator_checks: ["Verify migration completed", "Check payment.charge latency (should be normal)"],
  },
  confidence: {
    confidence_assessment: "High confidence — instantaneous onset/recovery matches lock acquisition/release pattern exactly.",
    uncertainty: "Cannot see pg_stat_activity directly; lock contention is inferred from db.query duration spike.",
  },
  metadata: { incident_id: "inc_db_lock", packet_id: "pkt_db_lock", model: "claude-sonnet-4.6", prompt_version: "v5", created_at: "2026-03-20T15:00:45Z" },
};

export const secretsRotation: DiagnosisResult = {
  summary: {
    what_happened: "API key rotation created split-brain: dpl_old uses revoked key_v1 (401→502), dpl_new uses valid key_v2 (200). Exactly 50% error rate.",
    root_cause_hypothesis: "key_v1 was revoked before dpl_old was decommissioned. Traffic splits evenly between deployments.",
  },
  recommendation: {
    immediate_action: "Decommission dpl_old immediately or re-enable key_v1 temporarily.",
    action_rationale_short: "Removes the split-brain state. All traffic routes to working deployment.",
    do_not: "Do not investigate SendGrid for an outage — dpl_new succeeds, proving the service is healthy.",
  },
  reasoning: {
    causal_chain: [
      { type: "external", title: "Key rotation", detail: "key_v1 revoked" },
      { type: "system", title: "Deployment skew", detail: "dpl_old still active with old key" },
      { type: "incident", title: "Split-brain auth", detail: "50% 401s from revoked key" },
      { type: "impact", title: "50% error rate", detail: "Perfectly correlated with deployment_id" },
    ],
  },
  operator_guidance: {
    watch_items: [{ label: "dpl_old traffic", state: "all failing", status: "critical" }],
    operator_checks: ["Verify dpl_old is still receiving traffic", "Confirm key_v2 is active on dpl_new"],
  },
  confidence: {
    confidence_assessment: "High confidence — error rate exactly 50%, perfectly split by deployment_id.",
    uncertainty: "Cannot confirm if there are additional deployments beyond dpl_old and dpl_new.",
  },
  metadata: { incident_id: "inc_secrets_rotation", packet_id: "pkt_secrets_rotation", model: "claude-sonnet-4.6", prompt_version: "v5", created_at: "2026-03-20T16:03:00Z" },
};

export const cdnCachePoison: DiagnosisResult = {
  summary: {
    what_happened: "CDN cached a 503 error response with Cache-Control: public, s-maxage=30. Origin recovered at T+10s but CDN served stale 503 for 20 more seconds.",
    root_cause_hypothesis: "No error-page cache purge policy. Cacheable headers on error responses allow CDN to serve stale errors.",
  },
  recommendation: {
    immediate_action: "Purge the CDN cache for affected routes and add Cache-Control: no-store to error responses.",
    action_rationale_short: "Immediate purge restores service. no-store prevents future error caching.",
    do_not: "Do not restart the origin server — it already recovered at T+10s.",
  },
  reasoning: {
    causal_chain: [
      { type: "external", title: "Origin 503", detail: "Brief error with cacheable headers" },
      { type: "system", title: "No error purge policy", detail: "CDN caches error response" },
      { type: "incident", title: "Stale 503 served", detail: "X-Cache: HIT on 503 after origin recovery" },
      { type: "impact", title: "Cached GET routes down", detail: "80% error rate on CDN-served routes" },
    ],
  },
  operator_guidance: {
    watch_items: [{ label: "CDN cache TTL", state: "30s from first error", status: "watch" }],
    operator_checks: ["Verify POST /checkout works (uncached)", "Check X-Cache headers on failing requests"],
  },
  confidence: {
    confidence_assessment: "High confidence — X-Cache: HIT on 503 responses after origin recovery is definitive.",
    uncertainty: "Cannot confirm if all CDN edge locations are affected.",
  },
  metadata: { incident_id: "inc_cdn_cache", packet_id: "pkt_cdn_cache", model: "claude-sonnet-4.6", prompt_version: "v5", created_at: "2026-03-20T17:01:00Z" },
};

export const sparseCase: DiagnosisResult = {
  summary: {
    what_happened: "Elevated error rate detected on unknown-service. Insufficient telemetry to determine root cause.",
    root_cause_hypothesis: "Unknown — only aggregate metric data available, no traces or logs.",
  },
  recommendation: {
    immediate_action: "Add tracing instrumentation to unknown-service to gather diagnostic data.",
    action_rationale_short: "Cannot diagnose without trace or log data.",
    do_not: "Do not take corrective action without understanding the root cause.",
  },
  reasoning: {
    causal_chain: [
      { type: "external", title: "Unknown trigger", detail: "No trace data available" },
      { type: "impact", title: "30% error rate", detail: "Observed via metrics only" },
    ],
  },
  operator_guidance: {
    watch_items: [{ label: "Error rate", state: "30% and stable", status: "watch" }],
    operator_checks: ["Add OTel tracing to unknown-service", "Check if service has log export configured"],
  },
  confidence: {
    confidence_assessment: "Low confidence — insufficient evidence for diagnosis.",
    uncertainty: "No traces or logs available. Diagnosis based on metrics alone.",
  },
  metadata: { incident_id: "inc_sparse", packet_id: "pkt_sparse", model: "claude-sonnet-4.6", prompt_version: "v5", created_at: "2026-03-20T18:02:00Z" },
};

export const allFixtures = {
  rateLimit,
  cascadingTimeout,
  dbMigrationLock,
  secretsRotation,
  cdnCachePoison,
  sparseCase,
} as const;
