/**
 * ReasoningStructure fixtures for 5 validation scenarios + 1 unanswerable case.
 * Hand-written from ground_truth.template.json files.
 * These represent what the receiver would deterministically produce.
 */
import type { ReasoningStructure } from "@3amoncall/core";

export const rateLimit: ReasoningStructure = {
  incidentId: "inc_rate_limit",
  evidenceCounts: { traces: 47, traceErrors: 12, metrics: 6, logs: 234, logErrors: 89 },
  blastRadius: [
    { targetId: "service:checkout-orchestrator", label: "checkout-orchestrator", status: "critical", impactValue: 0.68, displayValue: "68%" },
    { targetId: "service:order-service", label: "order-service", status: "degraded", impactValue: 0.23, displayValue: "23%" },
  ],
  proofRefs: [
    {
      cardId: "trigger",
      targetSurface: "traces",
      evidenceRefs: [
        { kind: "span", id: "tid:a3f8:sid:pay429" },
        { kind: "log", id: "checkout-orchestrator:1710940995000:stripe429hash" },
      ],
      status: "confirmed",
    },
    {
      cardId: "design_gap",
      targetSurface: "metrics",
      evidenceRefs: [
        { kind: "metric", id: "worker_pool_in_use::checkout-orchestrator" },
        { kind: "metric", id: "queue_depth::checkout-orchestrator" },
      ],
      status: "confirmed",
    },
    {
      cardId: "recovery",
      targetSurface: "logs",
      evidenceRefs: [],
      status: "pending",
    },
  ],
  absenceCandidates: [
    { id: "no-backoff", patterns: ["backoff", "retry_delay", "circuit_breaker"], searchWindow: { startMs: 1710940995000, endMs: 1710941490000 }, matchCount: 0 },
  ],
  timelineSummary: { startedAt: "2026-03-20T14:23:15Z", fullCascadeAt: "2026-03-20T14:25:30Z", diagnosedAt: "2026-03-20T14:27:45Z" },
  qaContext: { availableEvidenceKinds: ["traces", "metrics", "logs"] },
};

export const cascadingTimeout: ReasoningStructure = {
  incidentId: "inc_cascading_timeout",
  evidenceCounts: { traces: 38, traceErrors: 9, metrics: 5, logs: 180, logErrors: 56 },
  blastRadius: [
    { targetId: "route:/checkout", label: "/checkout", status: "critical", impactValue: 0.72, displayValue: "72%" },
    { targetId: "route:/api/orders", label: "/api/orders", status: "degraded", impactValue: 0.45, displayValue: "45%" },
  ],
  proofRefs: [
    {
      cardId: "trigger",
      targetSurface: "traces",
      evidenceRefs: [
        { kind: "span", id: "tid:b7e2:sid:notif_slow" },
      ],
      status: "confirmed",
    },
    {
      cardId: "design_gap",
      targetSurface: "metrics",
      evidenceRefs: [
        { kind: "metric", id: "worker_pool_in_use::web" },
        { kind: "metric_group", id: "hypothesis:pool_saturation" },
      ],
      status: "confirmed",
    },
    {
      cardId: "recovery",
      targetSurface: "traces",
      evidenceRefs: [
        { kind: "span", id: "tid:health:sid:200ok" },
      ],
      status: "inferred",
    },
  ],
  absenceCandidates: [
    { id: "no-notification-in-checkout", patterns: ["notification-svc"], searchWindow: { startMs: 1710941000000, endMs: 1710941300000 }, matchCount: 0 },
  ],
  timelineSummary: { startedAt: "2026-03-20T14:30:00Z", fullCascadeAt: "2026-03-20T14:31:45Z", diagnosedAt: null },
  qaContext: { availableEvidenceKinds: ["traces", "metrics", "logs"] },
};

export const dbMigrationLock: ReasoningStructure = {
  incidentId: "inc_db_lock",
  evidenceCounts: { traces: 25, traceErrors: 8, metrics: 4, logs: 120, logErrors: 42 },
  blastRadius: [
    { targetId: "route:/db/recent-orders", label: "/db/recent-orders", status: "critical", impactValue: 0.95, displayValue: "95%" },
    { targetId: "route:/checkout", label: "/checkout", status: "critical", impactValue: 0.60, displayValue: "60%" },
  ],
  proofRefs: [
    {
      cardId: "trigger",
      targetSurface: "traces",
      evidenceRefs: [
        { kind: "span", id: "tid:dbq:sid:lock_wait" },
      ],
      status: "confirmed",
    },
    {
      cardId: "design_gap",
      targetSurface: "metrics",
      evidenceRefs: [
        { kind: "metric", id: "db.query_duration::web" },
        { kind: "metric", id: "worker_pool_in_use::web" },
      ],
      status: "confirmed",
    },
    {
      cardId: "recovery",
      targetSurface: "traces",
      evidenceRefs: [
        { kind: "span", id: "tid:pay:sid:charge_ok" },
      ],
      status: "inferred",
    },
  ],
  absenceCandidates: [
    { id: "no-lock-timeout", patterns: ["lock_timeout", "statement_timeout"], searchWindow: { startMs: 1710941000000, endMs: 1710941040000 }, matchCount: 0 },
  ],
  timelineSummary: { startedAt: "2026-03-20T15:00:00Z", fullCascadeAt: "2026-03-20T15:00:10Z", diagnosedAt: "2026-03-20T15:00:45Z" },
  qaContext: { availableEvidenceKinds: ["traces", "metrics", "logs"] },
};

export const secretsRotation: ReasoningStructure = {
  incidentId: "inc_secrets_rotation",
  evidenceCounts: { traces: 30, traceErrors: 15, metrics: 3, logs: 150, logErrors: 75 },
  blastRadius: [
    { targetId: "deployment:dpl_old", label: "dpl_old (key_v1)", status: "critical", impactValue: 1.0, displayValue: "100%" },
    { targetId: "deployment:dpl_new", label: "dpl_new (key_v2)", status: "healthy", impactValue: 0.0, displayValue: "0%" },
  ],
  proofRefs: [
    {
      cardId: "trigger",
      targetSurface: "traces",
      evidenceRefs: [
        { kind: "span", id: "tid:mail:sid:401_old" },
        { kind: "log", id: "web:1710941100000:sendgrid401hash" },
      ],
      status: "confirmed",
    },
    {
      cardId: "design_gap",
      targetSurface: "metrics",
      evidenceRefs: [
        { kind: "metric", id: "http_error_rate::web" },
      ],
      status: "confirmed",
    },
    {
      cardId: "recovery",
      targetSurface: "traces",
      evidenceRefs: [
        { kind: "span", id: "tid:mail:sid:200_new" },
      ],
      status: "confirmed",
    },
  ],
  absenceCandidates: [],
  timelineSummary: { startedAt: "2026-03-20T16:00:00Z", fullCascadeAt: null, diagnosedAt: "2026-03-20T16:03:00Z" },
  qaContext: { availableEvidenceKinds: ["traces", "metrics", "logs"] },
};

export const cdnCachePoison: ReasoningStructure = {
  incidentId: "inc_cdn_cache",
  evidenceCounts: { traces: 20, traceErrors: 6, metrics: 3, logs: 90, logErrors: 30 },
  blastRadius: [
    { targetId: "route:GET/*", label: "CDN-cached GET routes", status: "critical", impactValue: 0.80, displayValue: "80%" },
  ],
  proofRefs: [
    {
      cardId: "trigger",
      targetSurface: "traces",
      evidenceRefs: [
        { kind: "span", id: "tid:cdn:sid:503_cached" },
      ],
      status: "confirmed",
    },
    {
      cardId: "design_gap",
      targetSurface: "logs",
      evidenceRefs: [
        { kind: "log", id: "web:1710941200000:cachecontrolhash" },
        { kind: "log_cluster", id: "claim:xcache_hit_503" },
      ],
      status: "confirmed",
    },
    {
      cardId: "recovery",
      targetSurface: "traces",
      evidenceRefs: [
        { kind: "span", id: "tid:post:sid:checkout_ok" },
      ],
      status: "inferred",
    },
  ],
  absenceCandidates: [
    { id: "no-error-purge", patterns: ["cache_purge", "invalidation", "purge_on_error"], searchWindow: { startMs: 1710941200000, endMs: 1710941230000 }, matchCount: 0 },
  ],
  timelineSummary: { startedAt: "2026-03-20T17:00:00Z", fullCascadeAt: null, diagnosedAt: "2026-03-20T17:01:00Z" },
  qaContext: { availableEvidenceKinds: ["traces", "logs"] },
};

/** Unanswerable case — sparse evidence, only metrics available */
export const unanswerableCase: ReasoningStructure = {
  incidentId: "inc_sparse",
  evidenceCounts: { traces: 0, traceErrors: 0, metrics: 2, logs: 0, logErrors: 0 },
  blastRadius: [
    { targetId: "service:unknown", label: "unknown-service", status: "degraded", impactValue: 0.30, displayValue: "30%" },
  ],
  proofRefs: [
    { cardId: "trigger", targetSurface: "metrics", evidenceRefs: [{ kind: "metric", id: "error_rate::unknown" }], status: "inferred" },
    { cardId: "design_gap", targetSurface: "metrics", evidenceRefs: [], status: "pending" },
    { cardId: "recovery", targetSurface: "logs", evidenceRefs: [], status: "pending" },
  ],
  absenceCandidates: [],
  timelineSummary: { startedAt: "2026-03-20T18:00:00Z", fullCascadeAt: null, diagnosedAt: null },
  qaContext: { availableEvidenceKinds: ["metrics"] },
};

export const allFixtures = {
  rateLimit,
  cascadingTimeout,
  dbMigrationLock,
  secretsRotation,
  cdnCachePoison,
  unanswerableCase,
} as const;
