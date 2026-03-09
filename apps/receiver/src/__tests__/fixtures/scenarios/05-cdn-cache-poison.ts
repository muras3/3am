import type { IncidentPacket, DiagnosisResult } from "@3amoncall/core";

// Scenario: upstream_cdn_stale_cache_poison
// Origin briefly returns 503 with Cache-Control: public, s-maxage=30.
// CDN caches the 503 response. Origin recovers within 10s.
// CDN continues serving stale 503 until TTL expires (~30s).
// Users see 503s even though origin is healthy.

export const packet: IncidentPacket = {
  schemaVersion: "incident-packet/v1alpha1",
  packetId: "pkt_scenario_05",
  incidentId: "inc_scenario_05",
  openedAt: "2026-03-09T11:00:00Z",
  status: "open",
  severity: "high",
  window: {
    start: "2026-03-09T10:55:00Z",
    detect: "2026-03-09T11:00:00Z",
    end: "2026-03-09T11:05:00Z",
  },
  scope: {
    environment: "production",
    primaryService: "cdn-edge",
    affectedServices: ["cdn-edge"],
    affectedRoutes: ["/", "/products", "/checkout"],
    affectedDependencies: [],
  },
  triggerSignals: [
    {
      signal: "CDN serving cached HTTP 503 — origin already recovered",
      firstSeenAt: "2026-03-09T11:00:00Z",
      entity: "cdn-edge",
    },
    {
      signal: "origin /health returning 200 while CDN returns 503 on /dashboard and /products",
      firstSeenAt: "2026-03-09T11:00:10Z",
      entity: "cdn-edge",
    },
  ],
  evidence: {
    changedMetrics: [],
    representativeTraces: [
      {
        traceId: "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1",
        spanId: "span_cdn_01",
        serviceName: "cdn-edge",
        durationMs: 50,
        httpStatusCode: 503,
        spanStatusCode: 2,
      },
      {
        traceId: "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1",
        spanId: "span_origin_01",
        serviceName: "origin",
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
      "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1",
      "e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    ],
    logRefs: [],
    metricRefs: [],
    platformLogRefs: [],
  },
};

export const diagnosis: DiagnosisResult = {
  summary: {
    what_happened:
      "The origin server briefly entered a degraded state and returned HTTP 503 responses " +
      "with Cache-Control: public, s-maxage=30. The CDN cached these 503 responses. " +
      "The origin recovered within 10 seconds, but the CDN continued serving the cached 503 " +
      "for the remaining ~20s of the cache TTL. Users received 503s from CDN edge nodes " +
      "even though the origin was fully healthy. CDN edge spans complete in 50ms " +
      "(cache hit from stale response) while origin spans show 200 OK at 800ms.",
    root_cause_hypothesis:
      "Origin 503 response was cached by CDN due to permissive Cache-Control: public, s-maxage=30 " +
      "on an error response. CDN did not revalidate after origin recovery. " +
      "Error responses must not be cacheable.",
  },
  recommendation: {
    immediate_action:
      "Purge the CDN cache for affected paths immediately: " +
      "POST /api/cache/purge with paths ['/dashboard', '/products', '/checkout']. " +
      "If CDN purge API is unavailable, temporarily disable CDN caching for these paths " +
      "by setting Cache-Control: no-store in origin responses.",
    action_rationale_short:
      "A cache purge removes the stale 503 from all CDN edge nodes within seconds, " +
      "restoring origin-direct traffic without a deployment or restart.",
    do_not:
      "Do not restart origin servers — they are healthy and restart would cause a real outage. " +
      "Do not increase CDN TTL for static content to compensate — the issue is caching errors, not content.",
  },
  reasoning: {
    causal_chain: [
      {
        type: "external",
        title: "Origin enters degraded state",
        detail:
          "Origin responds with HTTP 503 + Cache-Control: public, s-maxage=30. " +
          "The s-maxage directive tells shared caches (CDN) to cache this response for 30s.",
      },
      {
        type: "system",
        title: "CDN caches the 503 error response",
        detail:
          "CDN edge nodes store the 503 response per Cache-Control instructions. " +
          "All subsequent requests for /dashboard, /products, /checkout are served from cache " +
          "without hitting the origin.",
      },
      {
        type: "incident",
        title: "Origin recovers but CDN serves stale error",
        detail:
          "Origin recovers at T+10s. CDN does not revalidate — cache TTL has 20s remaining. " +
          "CDN spans show 50ms (cache hit). Origin spans show 200 OK at 800ms. " +
          "The disconnect between CDN and origin health is the key diagnostic signal.",
      },
      {
        type: "impact",
        title: "User-visible 503s for up to 30s after origin recovery",
        detail:
          "All cached routes (/dashboard, /products) return 503 until TTL expires. " +
          "/health bypasses CDN or is not cached — shows 200. " +
          "Incident appears self-resolving but will recur on next origin blip.",
      },
    ],
  },
  operator_guidance: {
    watch_items: [
      {
        label: "CDN cache hit rate on affected paths",
        state: "must drop after purge — cache bypass confirms purge succeeded",
        status: "alert",
      },
      {
        label: "origin /health",
        state: "already 200 — confirms origin is healthy",
        status: "ok",
      },
      {
        label: "CDN 503 rate on /dashboard and /products",
        state: "must reach zero within 60s of cache purge",
        status: "watch",
      },
    ],
    operator_checks: [
      "Run CDN cache purge API for all affected paths before checking origin",
      "Confirm CDN cache miss rate rises immediately after purge (X-Cache: MISS in response headers)",
      "Verify 503 rate reaches zero within 60s — if not, check CDN propagation delay",
      "Post-incident: add Cache-Control: no-store on all 4xx/5xx responses in origin middleware",
    ],
  },
  confidence: {
    confidence_assessment:
      "High confidence. The 50ms CDN span (cache hit) combined with simultaneous 200 OK on origin " +
      "is definitive evidence of stale cache serving. No other failure mode produces fast CDN 503s " +
      "with healthy origin responses.",
    uncertainty:
      "The root cause of the brief origin degradation is not captured in this packet. " +
      "If the origin degradation was caused by a deployment or external event, " +
      "it may recur and re-poison the cache.",
  },
  metadata: {
    incident_id: "inc_scenario_05",
    packet_id: "pkt_scenario_05",
    model: "claude-sonnet-4-6",
    prompt_version: "v5",
    created_at: "2026-03-09T11:01:00Z",
  },
};
