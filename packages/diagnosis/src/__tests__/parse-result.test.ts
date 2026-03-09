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
});
