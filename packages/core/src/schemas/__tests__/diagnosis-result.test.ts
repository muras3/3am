import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { DiagnosisResultSchema } from "../diagnosis-result.js";

const minimalValid = {
  summary: {
    what_happened: "Stripe 429s caused checkout 504s.",
    root_cause_hypothesis: "Fixed retries in shared pool amplified the failure.",
  },
  recommendation: {
    immediate_action: "Disable fixed retries.",
    action_rationale_short: "Fastest control point to reduce blast radius.",
    do_not: "Do not restart blindly.",
  },
  reasoning: {
    causal_chain: [
      { type: "external", title: "Stripe 429", detail: "rate limit begins" },
      { type: "system", title: "Retry loop", detail: "shared pool amplifies failure" },
      { type: "incident", title: "Queue climbs", detail: "local overload emerges" },
      { type: "impact", title: "Checkout 504", detail: "customer-visible failure" },
    ],
  },
  operator_guidance: {
    watch_items: [{ label: "Queue", state: "must flatten first", status: "watch" }],
    operator_checks: ["Confirm queue depth flattens within 30s"],
  },
  confidence: {
    confidence_assessment: "High confidence this is external-origin.",
    uncertainty: "Stripe quota bucket behavior is not visible in telemetry.",
  },
  metadata: {
    incident_id: "inc_123",
    packet_id: "pkt_123",
    model: "claude-sonnet-4.6",
    prompt_version: "v5",
    created_at: "2026-03-08T12:00:00Z",
  },
};

describe("DiagnosisResultSchema", () => {
  it("accepts a valid diagnosis result", () => {
    const result = DiagnosisResultSchema.parse(minimalValid);
    expect(result.metadata.incident_id).toBe("inc_123");
    expect(result.summary.what_happened).toBe("Stripe 429s caused checkout 504s.");
  });

  it("requires summary.what_happened and summary.root_cause_hypothesis", () => {
    expect(() =>
      DiagnosisResultSchema.parse({ ...minimalValid, summary: { what_happened: "x" } })
    ).toThrow(ZodError);
  });

  it("requires recommendation.immediate_action, action_rationale_short, do_not", () => {
    expect(() =>
      DiagnosisResultSchema.parse({ ...minimalValid, recommendation: { immediate_action: "x" } })
    ).toThrow(ZodError);
  });

  it("requires causal_chain items to have type, title, detail", () => {
    const badChain = {
      ...minimalValid,
      reasoning: { causal_chain: [{ title: "x" }] },
    };
    expect(() => DiagnosisResultSchema.parse(badChain)).toThrow(ZodError);
  });

  it("restricts causal_chain type to the four defined values", () => {
    const badType = {
      ...minimalValid,
      reasoning: {
        causal_chain: [{ type: "unknown_type", title: "x", detail: "y" }],
      },
    };
    expect(() => DiagnosisResultSchema.parse(badType)).toThrow(ZodError);
  });

  it("accepts all four causal_chain types: external, system, incident, impact", () => {
    const result = DiagnosisResultSchema.parse(minimalValid);
    const types = result.reasoning.causal_chain.map((s) => s.type);
    expect(types).toContain("external");
    expect(types).toContain("system");
    expect(types).toContain("incident");
    expect(types).toContain("impact");
  });

  it("requires operator_guidance.watch_items and operator_checks", () => {
    expect(() =>
      DiagnosisResultSchema.parse({ ...minimalValid, operator_guidance: {} })
    ).toThrow(ZodError);
  });

  it("requires confidence.confidence_assessment and uncertainty", () => {
    expect(() =>
      DiagnosisResultSchema.parse({ ...minimalValid, confidence: { confidence_assessment: "x" } })
    ).toThrow(ZodError);
  });

  it("requires metadata.incident_id, packet_id, model, prompt_version, created_at", () => {
    expect(() =>
      DiagnosisResultSchema.parse({ ...minimalValid, metadata: { incident_id: "inc_123" } })
    ).toThrow(ZodError);
  });

  it("does NOT contain raw traces, raw logs, raw metrics, or packet body fields (ADR 0019 non-goals)", () => {
    // With strict mode, embedding unknown top-level fields throws — which is the
    // correct behaviour: raw OTel data must never enter DiagnosisResult.
    const withRaw = {
      ...minimalValid,
      raw_traces: [{ traceId: "abc" }],
      raw_logs: ["log line"],
      raw_metrics: [{ name: "error_rate" }],
    };
    expect(() => DiagnosisResultSchema.parse(withRaw)).toThrow(ZodError);
    // Packet body fields must not be defined in the schema shape at all
    const packetFields = ["triggerSignals", "pointers", "evidence"];
    for (const field of packetFields) {
      expect(field in DiagnosisResultSchema.shape).toBe(false);
    }
  });

  it("rejects unknown fields at top level (strict mode)", () => {
    const withExtra = { ...minimalValid, unexpectedField: "oops" };
    expect(() => DiagnosisResultSchema.parse(withExtra)).toThrow(ZodError);
  });

  it("rejects unknown fields in summary (strict mode)", () => {
    const withExtra = {
      ...minimalValid,
      summary: { ...minimalValid.summary, extra: "bad" },
    };
    expect(() => DiagnosisResultSchema.parse(withExtra)).toThrow(ZodError);
  });

  // Fix 5.1: packet_generation backward compatibility
  describe("Fix 5.1: packet_generation optional field", () => {
    it("accepts existing records without packet_generation (backward compat)", () => {
      // minimalValid has no packet_generation — must parse successfully
      const result = DiagnosisResultSchema.parse(minimalValid);
      expect(result.metadata.packet_generation).toBeUndefined();
    });

    it("accepts records with packet_generation=0 (first generation)", () => {
      const withGen = {
        ...minimalValid,
        metadata: { ...minimalValid.metadata, packet_generation: 0 },
      };
      const result = DiagnosisResultSchema.parse(withGen);
      expect(result.metadata.packet_generation).toBe(0);
    });

    it("accepts records with packet_generation=6 (round-trip)", () => {
      const withGen = {
        ...minimalValid,
        metadata: { ...minimalValid.metadata, packet_generation: 6 },
      };
      const result = DiagnosisResultSchema.parse(withGen);
      expect(result.metadata.packet_generation).toBe(6);
    });

    it("rejects non-integer packet_generation", () => {
      const withBadGen = {
        ...minimalValid,
        metadata: { ...minimalValid.metadata, packet_generation: 1.5 },
      };
      expect(() => DiagnosisResultSchema.parse(withBadGen)).toThrow(ZodError);
    });

    it("rejects negative packet_generation", () => {
      const withBadGen = {
        ...minimalValid,
        metadata: { ...minimalValid.metadata, packet_generation: -1 },
      };
      expect(() => DiagnosisResultSchema.parse(withBadGen)).toThrow(ZodError);
    });
  });
});
