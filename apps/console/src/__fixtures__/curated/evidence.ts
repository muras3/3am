import type { EvidenceResponse } from "../../api/curated-types.js";

/** Happy path: 3 proof cards, Q&A with evidenceRefs, all surfaces populated */
export const evidenceReady: EvidenceResponse = {
  proofCards: [
    {
      id: "trigger",
      label: "External Trigger",
      status: "confirmed",
      summary: "Stripe API 429 responses starting at 14:23:15. Rate limit header shows 0/100 remaining.",
      targetSurface: "traces",
      evidenceRefs: [
        { kind: "span", id: "a3f8c91d:stripe-charge-001" },
        { kind: "log", id: "payment-service:1710943395:stripe429" },
      ],
    },
    {
      id: "design_gap",
      label: "Design Gap",
      status: "confirmed",
      summary: "No request batching in StripeClient. Error rate correlates 1:1 with traffic volume (r=0.97).",
      targetSurface: "metrics",
      evidenceRefs: [{ kind: "metric", id: "stripe_client_error_rate" }],
    },
    {
      id: "recovery",
      label: "Recovery Signal",
      status: "inferred",
      summary: "Retry traces with backoff show successful Stripe calls at reduced rate.",
      targetSurface: "traces",
      evidenceRefs: [{ kind: "span", id: "b7e2d44a:stripe-retry-001" }],
    },
  ],
  qa: {
    question: "Why are checkout payments failing?",
    answer:
      "Stripe API is returning 429 (rate limit exceeded) for all payment requests since 14:23:15 UTC. " +
      "The StripeClient makes one API call per checkout transaction with no batching, causing all 189 req/s " +
      "to hit Stripe's 100 req/s limit. The lack of retry/backoff logic means every 429 cascades as a 500 " +
      "to the checkout endpoint.",
    status: "answered",
    segments: [
      {
        id: "qa-ready-1",
        kind: "fact",
        text: "Stripe API is returning 429 responses on the checkout path since 14:23:15 UTC.",
        evidenceRefs: [{ kind: "span", id: "a3f8c91d:stripe-charge-001" }],
      },
      {
        id: "qa-ready-2",
        kind: "fact",
        text: "The strongest metric drift sits in the trigger metric group for Stripe API errors and rate-limit exhaustion.",
        evidenceRefs: [{ kind: "metric_group", id: "hyp-trigger" }],
      },
      {
        id: "qa-ready-3",
        kind: "inference",
        text: "That evidence matches the existing diagnosis that the one-call-per-checkout Stripe pattern is overrunning the quota and cascading into checkout failures.",
        evidenceRefs: [
          { kind: "span", id: "a3f8c91d:stripe-charge-001" },
          { kind: "metric_group", id: "hyp-trigger" },
        ],
      },
    ],
    evidenceRefs: [
      { kind: "span", id: "a3f8c91d:stripe-charge-001" },
      { kind: "metric_group", id: "hyp-trigger" },
    ],
    evidenceSummary: { traces: 12, metrics: 3, logs: 28 },
    followups: [
      { question: "Is there retry logic?", targetEvidenceKinds: ["logs", "traces"] },
      { question: "When exactly did this start?", targetEvidenceKinds: ["traces", "logs"] },
      { question: "What's the full blast radius?", targetEvidenceKinds: ["metrics"] },
      { question: "Will batching actually fix this?", targetEvidenceKinds: ["metrics", "traces"] },
    ],
  },
  surfaces: {
    traces: {
      observed: [
        {
          traceId: "a3f8c91d",
          route: "POST /checkout",
          status: 500,
          durationMs: 2340,
          expectedDurationMs: 245,
          annotation: "This trace shows a 429 from Stripe causing a 500 cascade. Expected duration: 245ms, actual: 2340ms.",
          spans: [
            {
              spanId: "checkout-001",
              name: "POST /checkout",
              durationMs: 2340,
              status: "error",
              attributes: { "http.request.method": "POST", "http.route": "/checkout", "http.response.status_code": 500 },
              correlatedLogs: [
                { timestamp: "14:23:16.234Z", severity: "error", body: "Payment failed: Stripe rate limit exceeded" },
              ],
            },
            {
              spanId: "stripe-charge-001",
              parentSpanId: "checkout-001",
              name: "StripeClient.charge",
              durationMs: 1990,
              status: "error",
              attributes: { "http.request.method": "POST", "url.full": "https://api.stripe.com/v1/charges", "http.response.status_code": 429 },
            },
            {
              spanId: "stripe-api-001",
              parentSpanId: "stripe-charge-001",
              name: "stripe-api POST /v1/charges",
              durationMs: 1405,
              status: "error",
              attributes: {
                "http.request.method": "POST",
                "url.full": "https://api.stripe.com/v1/charges",
                "http.response.status_code": 429,
                "x-ratelimit-limit": 100,
                "x-ratelimit-remaining": 0,
                "retry-after": 1,
                "span.status": "ERROR",
              },
            },
          ],
        },
      ],
      expected: [
        {
          traceId: "baseline-001",
          route: "POST /checkout",
          status: 200,
          durationMs: 245,
          annotation: "Healthy baseline from 14:15–14:22 UTC (42 samples). All spans complete within expected duration.",
          spans: [
            {
              spanId: "baseline-checkout-001",
              name: "POST /checkout",
              durationMs: 245,
              status: "ok",
              attributes: { "http.request.method": "POST", "http.route": "/checkout", "http.response.status_code": 200 },
            },
            {
              spanId: "baseline-stripe-001",
              parentSpanId: "baseline-checkout-001",
              name: "StripeClient.charge",
              durationMs: 180,
              status: "ok",
              attributes: { "http.response.status_code": 200 },
            },
          ],
        },
      ],
      smokingGunSpanId: "stripe-api-001",
      baseline: {
        source: "exact_operation",
        windowStart: "2024-03-20T14:15:00Z",
        windowEnd: "2024-03-20T14:22:00Z",
        sampleCount: 42,
        confidence: "high",
      },
    },
    metrics: {
      hypotheses: [
        {
          id: "hyp-trigger",
          type: "trigger",
          claim: "Stripe API error rate spiked when traffic exceeded rate limit",
          verdict: "Confirmed",
          metrics: [
            { name: "stripe_api.error_rate", value: "68.2%", expected: "0.1%", barPercent: 100 },
            { name: "stripe_api.req_per_sec", value: "189", expected: "85", barPercent: 89 },
            { name: "stripe_api.ratelimit_remaining", value: "0", expected: "15", barPercent: 100 },
          ],
        },
        {
          id: "hyp-cascade",
          type: "cascade",
          claim: "Payment failures propagated to order processing",
          verdict: "Confirmed",
          metrics: [
            { name: "checkout.error_rate", value: "68%", expected: "0.5%", barPercent: 97 },
            { name: "order.timeout_rate", value: "23%", expected: "0.2%", barPercent: 82 },
          ],
        },
        {
          id: "hyp-recovery",
          type: "recovery",
          claim: "Backoff retry pattern would reduce error rate",
          verdict: "Inferred",
          metrics: [
            { name: "retry.success_rate", value: "78%", expected: "n/a", barPercent: 78 },
          ],
        },
      ],
    },
    logs: {
      claims: [
        {
          id: "claim-429",
          type: "trigger",
          label: "Stripe 429 responses",
          count: 89,
          entries: [
            { timestamp: "14:23:15.001Z", severity: "error", body: "Stripe API returned 429: Rate limit exceeded", signal: true },
            { timestamp: "14:23:15.234Z", severity: "error", body: "Stripe API returned 429: Rate limit exceeded", signal: true },
            { timestamp: "14:23:16.567Z", severity: "error", body: "Stripe API returned 429: Rate limit exceeded", signal: false },
          ],
        },
        {
          id: "claim-timeout",
          type: "cascade",
          label: "Order processing timeouts",
          count: 28,
          entries: [
            { timestamp: "14:23:45.123Z", severity: "warn", body: "Order processing timeout after 30000ms", signal: true },
            { timestamp: "14:23:46.456Z", severity: "warn", body: "Order processing timeout after 30000ms", signal: false },
          ],
        },
        {
          id: "claim-no-retry",
          type: "absence",
          label: "No retry / backoff pattern found",
          count: 0,
          entries: [],
        },
      ],
    },
  },
  sideNotes: [
    {
      title: "Confidence",
      text: "High confidence (85%). Stripe 429 responses correlate directly with traffic exceeding the rate limit. The 1:1 call pattern in StripeClient is deterministic.",
      kind: "confidence",
    },
    {
      title: "Uncertainty",
      text: "Cannot confirm whether Stripe's rate limit was recently changed. The 100 req/s limit may be account-specific.",
      kind: "uncertainty",
    },
    {
      title: "Affected Dependencies",
      text: "Stripe API (primary), PostgreSQL (secondary — connection pool pressure from retries).",
      kind: "dependency",
    },
  ],
  state: {
    diagnosis: "ready",
    baseline: "ready",
    evidenceDensity: "rich",
  },
};

/** Pending: fixed-shape proof cards and QA, no narrative grounding yet */
export const evidencePending: EvidenceResponse = {
  proofCards: [
    {
      id: "trigger",
      label: "First failing path",
      status: "confirmed",
      summary: "Initial failing traces are already available and point to checkout → payment-service.",
      targetSurface: "traces",
      evidenceRefs: [{ kind: "span", id: "pend-trace-001:payment-auth-001" }],
    },
    {
      id: "design_gap",
      label: "Dependency comparison",
      status: "pending",
      summary: "Metrics comparison is reserved while the system checks whether the same drift repeats across requests.",
      targetSurface: "metrics",
      evidenceRefs: [],
    },
    {
      id: "recovery",
      label: "Recovery path",
      status: "pending",
      summary: "Recovery evidence stays open until a stable baseline and remediation signal are observed.",
      targetSurface: "traces",
      evidenceRefs: [],
    },
  ],
  qa: {
    question: "What evidence is available for payment-service /checkout?",
    answer: "You can already review the first failing checkout trace, its Stripe call, and the related log burst. That is enough to confirm the failing path before the narrative diagnosis completes.",
    status: "no_answer",
    segments: [
      {
        id: "qa-pending-1",
        kind: "unknown",
        text: "Diagnosis is still running, so the system is withholding a grounded conclusion and only surfacing the first failing path.",
        evidenceRefs: [{ kind: "span", id: "pend-trace-001:payment-auth-001" }],
      },
    ],
    evidenceRefs: [],
    evidenceSummary: { traces: 3, metrics: 0, logs: 8 },
    followups: [
      { question: "Open traces", targetEvidenceKinds: ["traces"] },
      { question: "Inspect metrics drift", targetEvidenceKinds: ["metrics"] },
      { question: "Review related logs", targetEvidenceKinds: ["logs"] },
    ],
    noAnswerReason: "Diagnosis narrative is pending; use the deterministic evidence surfaces below.",
  },
  surfaces: {
    traces: {
      observed: [
        {
          traceId: "pend-trace-001",
          route: "POST /checkout",
          status: 500,
          durationMs: 1820,
          expectedDurationMs: 260,
          annotation: "This is the earliest failing checkout request captured so far. It shows the path, not the full diagnosis.",
          spans: [
            {
              spanId: "checkout-entry-001",
              name: "POST /checkout",
              durationMs: 1820,
              status: "error",
              attributes: { "http.request.method": "POST", "http.route": "/checkout", "http.response.status_code": 500 },
            },
            {
              spanId: "payment-auth-001",
              parentSpanId: "checkout-entry-001",
              name: "payment-service.authorize",
              durationMs: 1490,
              status: "error",
              attributes: { "service.name": "payment-service", "dependency.candidate": "Stripe" },
              correlatedLogs: [
                { timestamp: "14:23:15.219Z", severity: "error", body: "authorization failed while contacting dependency" },
                { timestamp: "14:23:15.771Z", severity: "warn", body: "retry budget exhausted for dependency call" },
              ],
            },
          ],
        },
      ],
      expected: [],
      smokingGunSpanId: "payment-auth-001",
      baseline: { source: "none", windowStart: "", windowEnd: "", sampleCount: 0, confidence: "unavailable" },
    },
    metrics: { hypotheses: [] },
    logs: {
      claims: [
        {
          id: "pending-log-cluster",
          type: "trigger",
          label: "Dependency-call failures around checkout",
          count: 8,
          entries: [
            { timestamp: "14:23:15.219Z", severity: "error", body: "authorization failed while contacting dependency", signal: true },
            { timestamp: "14:23:15.771Z", severity: "warn", body: "retry budget exhausted for dependency call", signal: true },
            { timestamp: "14:23:16.104Z", severity: "error", body: "checkout request returned 500 after dependency failure", signal: false },
          ],
        },
      ],
    },
  },
  sideNotes: [],
  state: {
    diagnosis: "pending",
    baseline: "ready",
    evidenceDensity: "empty",
  },
};

/** Sparse: fixed-shape proof cards and QA, traces only, baseline unavailable */
export const evidenceSparse: EvidenceResponse = {
  proofCards: [
    {
      id: "trigger",
      label: "External Trigger",
      status: "confirmed",
      summary: "Stripe API 429 responses are confirmed in traces. This is the strongest signal so far.",
      targetSurface: "traces",
      evidenceRefs: [{ kind: "span", id: "a3f8c91d:stripe-charge-001" }],
    },
    {
      id: "design_gap",
      label: "Design Gap",
      status: "pending",
      summary: "A design-gap explanation is plausible, but not yet supported by enough comparative metrics.",
      targetSurface: "metrics",
      evidenceRefs: [],
    },
    {
      id: "recovery",
      label: "Recovery Path",
      status: "pending",
      summary: "Recovery guidance stays provisional until baseline behavior is available.",
      targetSurface: "traces",
      evidenceRefs: [],
    },
  ],
  qa: {
    question: "What evidence is available for payment-service /checkout?",
    answer: "The incident already has one confirmed trigger signal in traces. Use the evidence below as a directional read, not a complete explanation.",
    status: "no_answer",
    segments: [
      {
        id: "qa-sparse-1",
        kind: "unknown",
        text: "The diagnosis is still sparse, so this remains a directional read rather than a grounded conclusion.",
        evidenceRefs: [{ kind: "span", id: "a3f8c91d:stripe-charge-001" }],
      },
    ],
    evidenceRefs: [],
    evidenceSummary: { traces: 1, metrics: 0, logs: 0 },
    followups: [
      { question: "Open traces", targetEvidenceKinds: ["traces"] },
      { question: "Inspect metrics drift", targetEvidenceKinds: ["metrics"] },
      { question: "Review related logs", targetEvidenceKinds: ["logs"] },
    ],
    noAnswerReason: "The diagnosis is still sparse; use the strongest confirmed evidence below before expanding the hypothesis.",
  },
  surfaces: {
    traces: {
      observed: [
        {
          traceId: "a3f8c91d",
          route: "POST /checkout",
          status: 500,
          durationMs: 2340,
          spans: [
            {
              spanId: "stripe-charge-001",
              name: "StripeClient.charge",
              durationMs: 1990,
              status: "error",
              attributes: { "http.response.status_code": 429 },
            },
          ],
        },
      ],
      expected: [],
      smokingGunSpanId: "stripe-charge-001",
      baseline: { source: "none", windowStart: "", windowEnd: "", sampleCount: 0, confidence: "unavailable" },
    },
    metrics: { hypotheses: [] },
    logs: { claims: [] },
  },
  sideNotes: [
    {
      title: "Confidence",
      text: "Low-to-moderate confidence. The trigger signal is confirmed, but the broader cascade and recovery path remain open.",
      kind: "confidence",
    },
    {
      title: "Uncertainty",
      text: "Expected baseline data is not available, so the current trace should be read as a strong clue rather than a full comparison.",
      kind: "uncertainty",
    },
    {
      title: "Affected Dependencies",
      text: "Stripe is the primary confirmed dependency in scope. No secondary dependency is confirmed yet.",
      kind: "dependency",
    },
  ],
  state: {
    diagnosis: "ready",
    baseline: "unavailable",
    evidenceDensity: "sparse",
  },
};
