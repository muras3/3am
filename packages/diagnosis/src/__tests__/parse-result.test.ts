import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { parseResult } from "../parse-result.js";

const meta = {
  incidentId: "inc_test",
  packetId: "pkt_test",
  model: "claude-sonnet-4-6",
  promptVersion: "v5",
};

const validBody = {
  summary: {
    what_happened: "Stripe 429s caused checkout 500s.",
    root_cause_hypothesis: "Fixed retries amplified Stripe rate limit.",
  },
  recommendation: {
    immediate_action: "Disable retry loop.",
    action_rationale_short: "Fastest control point.",
    do_not: "Do not restart pods.",
  },
  reasoning: {
    causal_chain: [
      { type: "external", title: "Stripe 429", detail: "rate limit" },
      { type: "system", title: "Retry loop", detail: "amplifies" },
      { type: "incident", title: "Queue climbs", detail: "overload" },
      { type: "impact", title: "Checkout 500", detail: "customer visible" },
    ],
  },
  operator_guidance: {
    watch_items: [{ label: "Error rate", state: "must drop", status: "watch" }],
    operator_checks: ["Confirm error rate drops within 60s"],
  },
  confidence: {
    confidence_assessment: "High confidence.",
    uncertainty: "Stripe quota not visible.",
  },
};

describe("parseResult", () => {
  it("parses direct JSON string and adds metadata", () => {
    const raw = JSON.stringify(validBody);
    const result = parseResult(raw, meta);
    expect(result.metadata.incident_id).toBe("inc_test");
    expect(result.metadata.packet_id).toBe("pkt_test");
    expect(result.summary.what_happened).toBe("Stripe 429s caused checkout 500s.");
  });

  it("parses JSON wrapped in ```json code block", () => {
    const raw = "```json\n" + JSON.stringify(validBody) + "\n```";
    const result = parseResult(raw, meta);
    expect(result.summary.what_happened).toBe("Stripe 429s caused checkout 500s.");
  });

  it("parses JSON wrapped in ``` code block (no language tag)", () => {
    const raw = "```\n" + JSON.stringify(validBody) + "\n```";
    const result = parseResult(raw, meta);
    expect(result.summary.what_happened).toBe("Stripe 429s caused checkout 500s.");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseResult("not valid json", meta)).toThrow();
  });

  it("throws ZodError when JSON does not match DiagnosisResultSchema", () => {
    const invalid = JSON.stringify({ foo: "bar" });
    expect(() => parseResult(invalid, meta)).toThrow(ZodError);
  });

  it("metadata.created_at is a valid ISO string", () => {
    const raw = JSON.stringify(validBody);
    const result = parseResult(raw, meta);
    expect(() => new Date(result.metadata.created_at)).not.toThrow();
  });

  // Output size constraint tests
  it("throws when causal_chain has 9 steps (max 8)", () => {
    const step = { type: "system", title: "Step", detail: "detail" };
    const body = {
      ...validBody,
      reasoning: {
        causal_chain: Array.from({ length: 9 }, () => ({ ...step })),
      },
    };
    expect(() => parseResult(JSON.stringify(body), meta)).toThrow(
      /causal_chain.*9.*max 8/
    );
  });

  it("throws when watch_items has 11 items (max 10)", () => {
    const item = { label: "Error rate", state: "must drop", status: "watch" };
    const body = {
      ...validBody,
      operator_guidance: {
        ...validBody.operator_guidance,
        watch_items: Array.from({ length: 11 }, () => ({ ...item })),
      },
    };
    expect(() => parseResult(JSON.stringify(body), meta)).toThrow(
      /watch_items.*11.*max 10/
    );
  });

  it("throws when operator_checks has 11 items (max 10)", () => {
    const body = {
      ...validBody,
      operator_guidance: {
        ...validBody.operator_guidance,
        operator_checks: Array.from({ length: 11 }, () => "Check something"),
      },
    };
    expect(() => parseResult(JSON.stringify(body), meta)).toThrow(
      /operator_checks.*11.*max 10/
    );
  });

  it("throws when summary.what_happened exceeds 2000 chars", () => {
    const body = {
      ...validBody,
      summary: {
        ...validBody.summary,
        what_happened: "x".repeat(2001),
      },
    };
    const err = (() => {
      try {
        parseResult(JSON.stringify(body), meta);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeDefined();
    expect(err!.message).toContain("summary.what_happened");
    expect(err!.message).toContain("2001");
  });

  it("throws when causal_chain[].detail exceeds 500 chars", () => {
    const body = {
      ...validBody,
      reasoning: {
        causal_chain: [
          { type: "external", title: "Stripe 429", detail: "x".repeat(501) },
          { type: "system", title: "Retry loop", detail: "amplifies" },
          { type: "incident", title: "Queue climbs", detail: "overload" },
          { type: "impact", title: "Checkout 500", detail: "customer visible" },
        ],
      },
    };
    expect(() => parseResult(JSON.stringify(body), meta)).toThrow(
      /detail.*501.*max 500/
    );
  });

  it("does NOT throw when all fields are exactly at boundary", () => {
    const step = { type: "system" as const, title: "S", detail: "x".repeat(500) };
    const item = { label: "L", state: "S", status: "watch" };
    const body = {
      summary: {
        what_happened: "x".repeat(2000),
        root_cause_hypothesis: "x".repeat(2000),
      },
      recommendation: {
        immediate_action: "x".repeat(2000),
        action_rationale_short: "x".repeat(2000),
        do_not: "x".repeat(2000),
      },
      reasoning: {
        causal_chain: Array.from({ length: 8 }, () => ({ ...step })),
      },
      operator_guidance: {
        watch_items: Array.from({ length: 10 }, () => ({ ...item })),
        operator_checks: Array.from({ length: 10 }, () => "Check something"),
      },
      confidence: {
        confidence_assessment: "x".repeat(2000),
        uncertainty: "x".repeat(2000),
      },
    };
    expect(() => parseResult(JSON.stringify(body), meta)).not.toThrow();
  });
});
