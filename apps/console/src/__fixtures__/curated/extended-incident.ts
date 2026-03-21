import type { ExtendedIncident } from "../../api/curated-types.js";

/** Happy path: full diagnosis + blast radius + confidence */
export const extendedIncidentReady: ExtendedIncident = {
  incidentId: "inc_0892",
  status: "open",
  severity: "critical",
  openedAt: "2026-03-20T14:23:15Z",
  headline: "Stripe API rate limit cascade causing payment failures across all checkout flows",
  chips: [
    { type: "critical", label: "68% checkout errors" },
    { type: "external", label: "Stripe 429" },
    { type: "system", label: "No batching" },
  ],
  action: {
    text: "Enable request batching on StripeClient and add exponential backoff with jitter",
    rationale:
      "StripeClient sends 1:1 API calls per checkout transaction with no batching or retry logic. " +
      "At current traffic (189 req/s), this exceeds Stripe's 100 req/s rate limit. " +
      "Batching reduces call volume below the limit; backoff with jitter prevents retry storms during recovery.",
    doNot: "Request a Stripe rate limit increase — this masks the underlying design flaw and will fail again at the next traffic spike.",
  },
  rootCauseHypothesis:
    "The StripeClient service makes unbatched 1:1 API calls for every checkout transaction. " +
    "When traffic exceeds Stripe's rate limit (100 req/s), all calls receive 429 responses. " +
    "The lack of retry/backoff logic means failures cascade immediately to the checkout endpoint, " +
    "causing 68% error rates across all payment flows.",
  causalChain: [
    { type: "external", tag: "External Trigger", title: "Stripe API → 429", detail: "Rate limit hit at 14:23:15 UTC" },
    { type: "system", tag: "Design Gap", title: "No batching / backoff", detail: "1:1 call per transaction, no retry" },
    { type: "incident", tag: "Cascade", title: "Payment → order timeout", detail: "30s timeout propagation across services" },
    { type: "impact", tag: "User Impact", title: "68% checkout errors", detail: "HTTP 500 on POST /checkout" },
  ],
  operatorChecks: [
    "Verify Stripe dashboard shows rate limit exceeded",
    "Check if batching config exists but is disabled",
    "Confirm no recent deployment changed StripeClient",
  ],
  impactSummary: {
    startedAt: "2026-03-20T14:23:15Z",
    fullCascadeAt: "2026-03-20T14:25:30Z",
    diagnosedAt: "2026-03-20T14:27:45Z",
  },
  blastRadius: [
    { target: "payment-service", status: "critical", impactValue: 0.68, label: "68%" },
    { target: "order-service", status: "degraded", impactValue: 0.23, label: "23%" },
    { target: "4 other services", status: "healthy", impactValue: 0.01, label: "1%" },
  ],
  confidenceSummary: {
    label: "High confidence",
    value: 0.85,
    basis: "Stripe 429 ↔ traffic r=0.97",
    risk: "Backoff rollout without rate limiter guard may cause retry storm",
  },
  evidenceSummary: {
    traces: 47,
    traceErrors: 12,
    metrics: 6,
    logs: 234,
    logErrors: 89,
  },
  state: {
    diagnosis: "ready",
    baseline: "ready",
    evidenceDensity: "rich",
  },
};

/** Pending: diagnosis not yet available */
export const extendedIncidentPending: ExtendedIncident = {
  incidentId: "inc_0892",
  status: "open",
  severity: "critical",
  openedAt: "2026-03-20T14:23:15Z",
  headline: "",
  chips: [],
  action: { text: "", rationale: "", doNot: "" },
  rootCauseHypothesis: "",
  causalChain: [],
  operatorChecks: [],
  impactSummary: {
    startedAt: "2026-03-20T14:23:15Z",
    fullCascadeAt: "",
    diagnosedAt: "",
  },
  blastRadius: [],
  confidenceSummary: { label: "", value: 0, basis: "", risk: "" },
  evidenceSummary: { traces: 0, traceErrors: 0, metrics: 0, logs: 0, logErrors: 0 },
  state: {
    diagnosis: "pending",
    baseline: "ready",
    evidenceDensity: "empty",
  },
};

/** Sparse: diagnosis ready but minimal data */
export const extendedIncidentSparse: ExtendedIncident = {
  incidentId: "inc_0892",
  status: "open",
  severity: "medium",
  openedAt: "2026-03-20T14:23:15Z",
  headline: "Elevated error rate on /checkout",
  chips: [{ type: "critical", label: "12% errors" }],
  action: {
    text: "Investigate Stripe client error responses",
    rationale: "Error rate elevated but root cause unclear from limited data.",
    doNot: "",
  },
  rootCauseHypothesis: "Insufficient data to determine root cause with high confidence.",
  causalChain: [
    { type: "incident", tag: "Observation", title: "Elevated errors", detail: "12% error rate on /checkout" },
  ],
  operatorChecks: ["Check external dependency status pages"],
  impactSummary: {
    startedAt: "2026-03-20T14:23:15Z",
    fullCascadeAt: "",
    diagnosedAt: "2026-03-20T14:28:00Z",
  },
  blastRadius: [
    { target: "payment-service", status: "degraded", impactValue: 0.12, label: "12%" },
  ],
  confidenceSummary: {
    label: "Low confidence",
    value: 0.35,
    basis: "Limited trace data",
    risk: "Root cause may be misidentified",
  },
  evidenceSummary: { traces: 5, traceErrors: 2, metrics: 1, logs: 12, logErrors: 4 },
  state: {
    diagnosis: "ready",
    baseline: "insufficient",
    evidenceDensity: "sparse",
  },
};
