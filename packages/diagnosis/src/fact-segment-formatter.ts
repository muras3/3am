/**
 * fact-segment-formatter.ts — Locale-aware formatters for deterministic fact segments.
 *
 * These segments are built by code (not LLM) from structured evidence data.
 * All user-visible strings go through this module to ensure consistent i18n.
 */

export type FactSegmentLocale = "en" | "ja";

export type MetricGroupInput = {
  id: string;
  claim: string;
  verdict: string;
  metrics: Array<{ name: string; value: string | number; expected: string | number }>;
};

export type LogClaimInput = {
  label: string;
  type: string;
  count: number;
  sampleBody?: string;
  explanation?: string;
};

export type TraceSpanInput = {
  route: string;
  spanName: string;
  httpStatus?: string | number;
  spanStatus?: string | number;
  durationMs: number;
};

/**
 * Format a metric group hypothesis as a human-readable fact sentence.
 */
export function formatMetricFact(group: MetricGroupInput, locale: FactSegmentLocale): string {
  if (locale === "ja") {
    const metricList = group.metrics
      .map((m) => `${m.name}: 観測値 ${m.value}、期待値 ${m.expected}`)
      .join("；");
    const base = `メトリクスグループ ${group.id} は ${group.claim} を示し、判定は ${group.verdict} です。`;
    return metricList.length > 0 ? `${base}観測メトリクス: ${metricList}。` : base;
  }
  const metricList = group.metrics
    .map((m) => `${m.name} observed ${m.value} versus expected ${m.expected}`)
    .join("; ");
  const base = `Metric group ${group.id} indicates ${group.claim} Verdict=${group.verdict}.`;
  return metricList.length > 0 ? `${base} Observed metrics: ${metricList}.` : base;
}

/**
 * Format a log claim as a human-readable fact sentence.
 */
export function formatLogFact(claim: LogClaimInput, locale: FactSegmentLocale): string {
  if (locale === "ja") {
    let text = `ログ証跡 ${claim.label}（${claim.type}）が ${claim.count} 回発生しました。`;
    if (claim.sampleBody) {
      text += `サンプルログ: ${claim.sampleBody}。`;
    }
    if (claim.explanation) {
      text += `説明: ${claim.explanation}。`;
    }
    return text;
  }
  let text = `Log evidence ${claim.label} of type ${claim.type} appeared ${claim.count} times.`;
  if (claim.sampleBody) {
    text += ` Sample log: ${claim.sampleBody}.`;
  }
  if (claim.explanation) {
    text += ` Explanation: ${claim.explanation}.`;
  }
  return text;
}

/**
 * Format a trace span as a human-readable fact sentence.
 */
export function formatTraceFact(span: TraceSpanInput, locale: FactSegmentLocale): string {
  const statusPart =
    span.httpStatus !== undefined
      ? locale === "ja"
        ? ` HTTPステータス=${span.httpStatus}`
        : ` httpStatus=${span.httpStatus}`
      : locale === "ja"
        ? ` ステータス=${span.spanStatus}`
        : ` status=${span.spanStatus}`;

  if (locale === "ja") {
    return `トレース ${span.route} スパン ${span.spanName} は${statusPart} で終了し、処理時間は ${span.durationMs}ms でした。`;
  }
  return `Trace ${span.route} span ${span.spanName} returned${statusPart} with durationMs=${span.durationMs}.`;
}
