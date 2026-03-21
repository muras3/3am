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
      id: "design",
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
    evidenceRefs: [
      { kind: "proof_card", id: "trigger" },
      { kind: "span", id: "a3f8c91d:stripe-charge-001" },
    ],
    evidenceSummary: { traces: 12, metrics: 3, logs: 28 },
    followups: [
      "Is there retry logic?",
      "When exactly did this start?",
      "What's the full blast radius?",
      "Will batching actually fix this?",
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
              attributes: { "http.method": "POST", "http.route": "/checkout", "http.status_code": 500 },
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
              attributes: { "http.method": "POST", "http.url": "https://api.stripe.com/v1/charges", "http.status_code": 429 },
            },
            {
              spanId: "stripe-api-001",
              parentSpanId: "stripe-charge-001",
              name: "stripe-api POST /v1/charges",
              durationMs: 1405,
              status: "error",
              attributes: {
                "http.method": "POST",
                "http.url": "https://api.stripe.com/v1/charges",
                "http.status_code": 429,
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
              attributes: { "http.method": "POST", "http.route": "/checkout", "http.status_code": 200 },
            },
            {
              spanId: "baseline-stripe-001",
              parentSpanId: "baseline-checkout-001",
              name: "StripeClient.charge",
              durationMs: 180,
              status: "ok",
              attributes: { "http.status_code": 200 },
            },
          ],
        },
      ],
      smokingGunSpanId: "stripe-api-001",
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
      content: "High confidence (85%). Stripe 429 responses correlate directly with traffic exceeding the rate limit. The 1:1 call pattern in StripeClient is deterministic.",
      variant: "primary",
    },
    {
      title: "Uncertainty",
      content: "Cannot confirm whether Stripe's rate limit was recently changed. The 100 req/s limit may be account-specific.",
    },
    {
      title: "Affected Dependencies",
      content: "Stripe API (primary), PostgreSQL (secondary — connection pool pressure from retries).",
    },
  ],
  state: {
    diagnosis: "ready",
    baseline: "ready",
    evidenceDensity: "rich",
  },
};

/** Pending: no proof cards, no Q&A */
export const evidencePending: EvidenceResponse = {
  proofCards: [],
  qa: null,
  surfaces: {
    traces: { observed: [], expected: [], smokingGunSpanId: null },
    metrics: { hypotheses: [] },
    logs: { claims: [] },
  },
  sideNotes: [],
  state: {
    diagnosis: "pending",
    baseline: "ready",
    evidenceDensity: "empty",
  },
};

/** Sparse: 1 proof card, traces only, baseline unavailable */
export const evidenceSparse: EvidenceResponse = {
  proofCards: [
    {
      id: "trigger",
      label: "External Trigger",
      status: "confirmed",
      summary: "Stripe API 429 responses detected.",
      targetSurface: "traces",
      evidenceRefs: [{ kind: "span", id: "a3f8c91d:stripe-charge-001" }],
    },
  ],
  qa: null,
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
              attributes: { "http.status_code": 429 },
            },
          ],
        },
      ],
      expected: [],
      smokingGunSpanId: "stripe-charge-001",
    },
    metrics: { hypotheses: [] },
    logs: { claims: [] },
  },
  sideNotes: [],
  state: {
    diagnosis: "ready",
    baseline: "unavailable",
    evidenceDensity: "sparse",
  },
};
