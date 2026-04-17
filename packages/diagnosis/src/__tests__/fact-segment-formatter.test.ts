/**
 * fact-segment-formatter.test.ts — Unit tests for locale-aware fact segment formatters.
 */
import { describe, it, expect } from "vitest";
import {
  formatMetricFact,
  formatLogFact,
  formatTraceFact,
  type MetricGroupInput,
  type LogClaimInput,
  type TraceSpanInput,
} from "../fact-segment-formatter.js";

// ── formatMetricFact ──────────────────────────────────────────────────────────

describe("formatMetricFact", () => {
  const group: MetricGroupInput = {
    id: "mgroup:0",
    claim: "e2e-order-app-vercel latency",
    verdict: "Inferred",
    metrics: [
      { name: "latency_p99", value: 4500, expected: 800 },
    ],
  };

  it("returns English output for locale=en", () => {
    const result = formatMetricFact(group, "en");
    expect(result).toContain("Metric group mgroup:0");
    expect(result).toContain("e2e-order-app-vercel latency");
    expect(result).toContain("Verdict=Inferred");
    expect(result).toContain("latency_p99 observed 4500 versus expected 800");
  });

  it("returns Japanese output for locale=ja", () => {
    const result = formatMetricFact(group, "ja");
    expect(result).toContain("メトリクスグループ mgroup:0");
    expect(result).toContain("e2e-order-app-vercel latency");
    expect(result).toContain("判定は Inferred");
    expect(result).toContain("latency_p99");
    expect(result).toContain("4500");
    expect(result).toContain("800");
  });

  it("handles empty metrics list in English", () => {
    const noMetrics: MetricGroupInput = { ...group, metrics: [] };
    const result = formatMetricFact(noMetrics, "en");
    expect(result).toContain("Metric group mgroup:0");
    expect(result).not.toContain("Observed metrics:");
  });

  it("handles empty metrics list in Japanese", () => {
    const noMetrics: MetricGroupInput = { ...group, metrics: [] };
    const result = formatMetricFact(noMetrics, "ja");
    expect(result).toContain("メトリクスグループ mgroup:0");
    expect(result).not.toContain("観測メトリクス:");
  });
});

// ── formatLogFact ─────────────────────────────────────────────────────────────

describe("formatLogFact", () => {
  const claim: LogClaimInput = {
    label: "e2e-order-app-vercel error logs",
    type: "cascade",
    count: 2,
  };

  it("returns English output for locale=en", () => {
    const result = formatLogFact(claim, "en");
    expect(result).toBe(
      "Log evidence e2e-order-app-vercel error logs of type cascade appeared 2 times.",
    );
  });

  it("returns Japanese output for locale=ja", () => {
    const result = formatLogFact(claim, "ja");
    expect(result).toContain("ログ証跡 e2e-order-app-vercel error logs");
    expect(result).toContain("cascade");
    expect(result).toContain("2 回発生");
  });

  it("includes sample body in English", () => {
    const result = formatLogFact({ ...claim, sampleBody: "Stripe 429" }, "en");
    expect(result).toContain("Sample log: Stripe 429");
  });

  it("includes sample body in Japanese", () => {
    const result = formatLogFact({ ...claim, sampleBody: "Stripe 429" }, "ja");
    expect(result).toContain("サンプルログ: Stripe 429");
  });

  it("includes explanation in English", () => {
    const result = formatLogFact({ ...claim, explanation: "Rate limit hit" }, "en");
    expect(result).toContain("Explanation: Rate limit hit");
  });

  it("includes explanation in Japanese", () => {
    const result = formatLogFact({ ...claim, explanation: "Rate limit hit" }, "ja");
    expect(result).toContain("説明: Rate limit hit");
  });
});

// ── formatTraceFact ───────────────────────────────────────────────────────────

describe("formatTraceFact", () => {
  const span: TraceSpanInput = {
    route: "/api/checkout",
    spanName: "POST /checkout",
    httpStatus: 504,
    durationMs: 1200,
  };

  it("returns English output with httpStatus for locale=en", () => {
    const result = formatTraceFact(span, "en");
    expect(result).toContain("Trace /api/checkout span POST /checkout returned");
    expect(result).toContain("httpStatus=504");
    expect(result).toContain("durationMs=1200");
  });

  it("returns Japanese output with httpStatus for locale=ja", () => {
    const result = formatTraceFact(span, "ja");
    expect(result).toContain("トレース /api/checkout");
    expect(result).toContain("POST /checkout");
    expect(result).toContain("HTTPステータス=504");
    expect(result).toContain("1200ms");
  });

  it("falls back to spanStatus when httpStatus is absent in English", () => {
    const spanNoHttp: TraceSpanInput = { ...span, httpStatus: undefined, spanStatus: "OK" };
    const result = formatTraceFact(spanNoHttp, "en");
    expect(result).toContain("status=OK");
    expect(result).not.toContain("httpStatus");
  });

  it("falls back to spanStatus when httpStatus is absent in Japanese", () => {
    const spanNoHttp: TraceSpanInput = { ...span, httpStatus: undefined, spanStatus: "OK" };
    const result = formatTraceFact(spanNoHttp, "ja");
    expect(result).toContain("ステータス=OK");
    expect(result).not.toContain("HTTPステータス");
  });
});
