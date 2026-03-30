/**
 * Tests for locale support in buildPrompt and buildNarrativePrompt.
 */
import { describe, it, expect } from "vitest";
import { buildPrompt } from "../prompt.js";
import { buildNarrativePrompt } from "../narrative-prompt.js";
import { buildEvidenceQueryPrompt } from "../evidence-query-prompt.js";
import type { IncidentPacket, DiagnosisResult, ReasoningStructure } from "@3amoncall/core";

const packet: IncidentPacket = {
  schemaVersion: "incident-packet/v1alpha1",
  packetId: "pkt_locale_test",
  incidentId: "inc_locale_test",
  openedAt: "2026-03-09T00:00:00Z",
  window: {
    start: "2026-03-09T00:00:00Z",
    detect: "2026-03-09T00:01:00Z",
    end: "2026-03-09T00:05:00Z",
  },
  scope: {
    environment: "production",
    primaryService: "checkout-api",
    affectedServices: ["checkout-api"],
    affectedRoutes: ["/checkout"],
    affectedDependencies: ["stripe"],
  },
  triggerSignals: [
    { signal: "http_500", firstSeenAt: "2026-03-09T00:01:00Z", entity: "checkout-api" },
  ],
  evidence: {
    changedMetrics: [],
    representativeTraces: [],
    relevantLogs: [],
    platformEvents: [],
  },
  pointers: {
    traceRefs: [],
    logRefs: [],
    metricRefs: [],
    platformLogRefs: [],
  },
};

const diagnosisResult: DiagnosisResult = {
  summary: {
    what_happened: "Rate limiter cascade.",
    root_cause_hypothesis: "Stripe 429.",
  },
  recommendation: {
    immediate_action: "Disable retry loop.",
    action_rationale_short: "Stops cascade.",
    do_not: "Do not increase timeout.",
  },
  reasoning: {
    causal_chain: [{ type: "external", title: "Stripe 429", detail: "Rate limited." }],
  },
  operator_guidance: {
    watch_items: [],
    operator_checks: ["Check Stripe dashboard."],
  },
  confidence: {
    confidence_assessment: "High",
    uncertainty: "Unknown reset time.",
  },
  metadata: {
    incident_id: "inc_locale_test",
    packet_id: "pkt_locale_test",
    model: "claude-haiku-4-5-20251001",
    prompt_version: "v5",
    created_at: "2026-03-09T00:10:00Z",
  },
};

const context: ReasoningStructure = {
  incidentId: "inc_locale_test",
  evidenceCounts: { traces: 1, traceErrors: 1, metrics: 0, logs: 0, logErrors: 0 },
  blastRadius: [{ label: "checkout-api", status: "alert", displayValue: "100% errors" }],
  proofRefs: [],
  absenceCandidates: [],
  timelineSummary: {
    startedAt: "2026-03-09T00:00:00Z",
    fullCascadeAt: "2026-03-09T00:01:00Z",
    diagnosedAt: "2026-03-09T00:10:00Z",
  },
  qaContext: { availableEvidenceKinds: ["traces"] },
};

describe("buildPrompt locale support", () => {
  it("does not include Japanese instruction when locale is undefined", () => {
    const prompt = buildPrompt(packet);
    expect(prompt).not.toContain("Respond entirely in Japanese");
  });

  it("does not include Japanese instruction when locale is 'en'", () => {
    const prompt = buildPrompt(packet, { locale: "en" });
    expect(prompt).not.toContain("Respond entirely in Japanese");
  });

  it("includes Japanese instruction when locale is 'ja'", () => {
    const prompt = buildPrompt(packet, { locale: "ja" });
    expect(prompt).toContain("Respond entirely in Japanese");
    expect(prompt).toContain("Keep all JSON keys in English");
    expect(prompt).toContain("action-oriented");
  });

  it("still includes all standard sections when locale is 'ja'", () => {
    const prompt = buildPrompt(packet, { locale: "ja" });
    expect(prompt).toContain("7-Step SRE Investigation");
    expect(prompt).toContain("Required Output Format");
    expect(prompt).toContain("checkout-api");
  });
});

describe("buildNarrativePrompt locale support", () => {
  it("does not include Japanese instruction when locale is undefined", () => {
    const prompt = buildNarrativePrompt(diagnosisResult, context);
    expect(prompt).not.toContain("Respond entirely in Japanese");
  });

  it("does not include Japanese instruction when locale is 'en'", () => {
    const prompt = buildNarrativePrompt(diagnosisResult, context, { locale: "en" });
    expect(prompt).not.toContain("Respond entirely in Japanese");
  });

  it("includes Japanese instruction when locale is 'ja'", () => {
    const prompt = buildNarrativePrompt(diagnosisResult, context, { locale: "ja" });
    expect(prompt).toContain("Respond entirely in Japanese");
    expect(prompt).toContain("Keep all JSON keys in English");
  });

  it("still includes all standard sections when locale is 'ja'", () => {
    const prompt = buildNarrativePrompt(diagnosisResult, context, { locale: "ja" });
    expect(prompt).toContain("Output Instructions");
    expect(prompt).toContain("WORDING ONLY");
    expect(prompt).toContain("proofCards");
  });
});

describe("buildEvidenceQueryPrompt routing support", () => {
  it("includes Japanese instruction and question routing metadata", () => {
    const prompt = buildEvidenceQueryPrompt({
      question: "メトリクスに問題はあるか？",
      intent: "metrics",
      preferredSurfaces: ["metrics", "traces", "logs"],
      diagnosis: {
        whatHappened: diagnosisResult.summary.what_happened,
        rootCauseHypothesis: diagnosisResult.summary.root_cause_hypothesis,
        immediateAction: diagnosisResult.recommendation.immediate_action,
        causalChain: diagnosisResult.reasoning.causal_chain.map((step) => step.title),
      },
      evidence: [{
        ref: { kind: "metric_group", id: "mgroup:0" },
        surface: "metrics",
        summary: "Metric group mgroup:0 indicates checkout error rate spiked.",
      }],
    }, { locale: "ja" });

    expect(prompt).toContain("Respond entirely in Japanese");
    expect(prompt).toContain("question_intent: metrics");
    expect(prompt).toContain("preferred_surfaces: metrics, traces, logs");
    expect(prompt).toContain("If the question is about metrics, answer primarily from metric evidence");
  });
});
