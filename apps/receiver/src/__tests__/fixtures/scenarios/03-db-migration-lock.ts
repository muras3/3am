import type { IncidentPacket, DiagnosisResult } from "@3am/core";

// Scenario: db_migration_lock_contention
// Long-running analytics query holds ShareLock →
// ALTER TABLE migration queues AccessExclusiveLock →
// all subsequent readers queue behind migration →
// connection pool exhausted → API timeouts

export const packet: IncidentPacket = {
  schemaVersion: "incident-packet/v1alpha1",
  packetId: "pkt_scenario_03",
  incidentId: "inc_scenario_03",
  openedAt: "2026-03-09T07:00:00Z",
  status: "open",
  signalSeverity: "high",
  window: {
    start: "2026-03-09T06:55:00Z",
    detect: "2026-03-09T07:00:00Z",
    end: "2026-03-09T07:05:00Z",
  },
  scope: {
    environment: "production",
    primaryService: "web",
    affectedServices: ["web"],
    affectedRoutes: ["/api/orders", "/api/products"],
    affectedDependencies: ["postgres"],
  },
  triggerSignals: [
    {
      signal: "ALTER TABLE lock wait exceeding 30s on orders table",
      firstSeenAt: "2026-03-09T07:00:00Z",
      entity: "postgres",
    },
    {
      signal: "query_wait_timeout errors on /api/orders and /api/products",
      firstSeenAt: "2026-03-09T07:00:15Z",
      entity: "web",
    },
  ],
  evidence: {
    changedMetrics: [],
    representativeTraces: [
      {
        traceId: "e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        spanId: "span_orders_db_01",
        serviceName: "web",
        durationMs: 12000,
        httpStatusCode: 500,
        spanStatusCode: 2,
      },
      {
        traceId: "e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        spanId: "span_migration_01",
        serviceName: "db-migration",
        durationMs: 30000,
        spanStatusCode: 2,
      },
    ],
    relevantLogs: [],
    platformEvents: [],
  },
  pointers: {
    traceRefs: [
      "e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      "f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
    ],
    logRefs: [],
    metricRefs: [],
    platformLogRefs: [],
  },
};

export const diagnosis: DiagnosisResult = {
  summary: {
    what_happened:
      "A long-running analytics query held a ShareLock on the orders table for ~5 seconds. " +
      "A concurrent ALTER TABLE migration (adding an index) needed an AccessExclusiveLock " +
      "and queued behind the analytics query. PostgreSQL's lock queue blocks all subsequent " +
      "readers, causing application queries on /api/orders and /api/products to wait. " +
      "The connection pool exhausted within seconds and API requests began returning 500.",
    root_cause_hypothesis:
      "Long-running analytics query (reader_hold_sec ≈ 5s) blocked an ALTER TABLE migration " +
      "that acquired an AccessExclusiveLock. PostgreSQL's lock queue priority caused all " +
      "subsequent ShareLock requests to wait behind the migration, starving the connection pool.",
  },
  recommendation: {
    immediate_action:
      "Terminate the blocked migration session (SELECT pg_cancel_backend(<pid>)) " +
      "to release the AccessExclusiveLock and unblock the lock queue immediately. " +
      "Then terminate any remaining stale analytics queries. " +
      "Re-run migration during low-traffic window using CREATE INDEX CONCURRENTLY.",
    action_rationale_short:
      "Cancelling the migration releases the AccessExclusiveLock instantly, " +
      "draining the lock queue and restoring connection pool capacity without a restart.",
    do_not:
      "Do not restart the database — active connections and in-flight transactions would be lost. " +
      "Do not re-run ALTER TABLE without CONCURRENTLY option; it will re-create the same lock contention.",
  },
  reasoning: {
    causal_chain: [
      {
        type: "system",
        title: "Analytics query holds ShareLock",
        detail:
          "Long-running SELECT on orders table holds ShareLock for ~5s " +
          "(reader_hold_sec=5). This is elevated but not immediately harmful.",
      },
      {
        type: "system",
        title: "ALTER TABLE queues AccessExclusiveLock",
        detail:
          "Migration runner issues ALTER TABLE orders ADD COLUMN. PostgreSQL queues " +
          "AccessExclusiveLock. Lock queue now blocks all subsequent readers behind the migration.",
      },
      {
        type: "incident",
        title: "Connection pool exhaustion",
        detail:
          "Application queries on /api/orders and /api/products cannot acquire connections — " +
          "all pool slots held by queries waiting in the lock queue. " +
          "pool_exhausted_count rises to db_connection_limit.",
      },
      {
        type: "impact",
        title: "API 500 errors on database-backed routes",
        detail:
          "Requests to /api/orders and /api/products fail with query_wait_timeout (12s spans). " +
          "/health is unaffected (no DB call). " +
          "Elevated db_connection_count is observable but is a symptom, not a cause.",
      },
    ],
  },
  operator_guidance: {
    watch_items: [
      {
        label: "pg_locks — AccessExclusiveLock on orders",
        state: "must clear before connection pool recovers",
        status: "alert",
      },
      {
        label: "connection pool available slots",
        state: "must return to >50% within 30s of lock release",
        status: "watch",
      },
      {
        label: "db_connection_count",
        state: "red herring — elevated count is a symptom of pool starvation",
        status: "ok",
      },
    ],
    operator_checks: [
      "Run: SELECT pid, query, wait_event_type, wait_event FROM pg_stat_activity WHERE wait_event_type='Lock'",
      "Confirm AccessExclusiveLock is cleared after pg_cancel_backend",
      "Verify /api/orders returns 200 within 60s of lock release",
      "Schedule next migration for off-peak hours using CREATE INDEX CONCURRENTLY",
    ],
  },
  confidence: {
    confidence_assessment:
      "High confidence. Lock contention timeline, migration span duration, " +
      "and connection pool exhaustion metrics converge on a single causal path. " +
      "Elevated db_connection_count correctly identified as a symptom, not the cause.",
    uncertainty:
      "The analytics query source is unknown — it may be an ad-hoc query from a reporting tool " +
      "or a scheduled job. Identifying and rate-limiting the analytics query source " +
      "is needed to prevent recurrence.",
  },
  metadata: {
    incident_id: "inc_scenario_03",
    packet_id: "pkt_scenario_03",
    model: "claude-sonnet-4-6",
    prompt_version: "v5",
    created_at: "2026-03-09T07:01:00Z",
  },
};
