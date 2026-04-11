import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "./fixtures/receiver-worker.js";
import { D1StorageAdapter } from "../../storage/drizzle/d1.js";
import { D1TelemetryAdapter } from "../../telemetry/drizzle/d1.js";
import { makeMembership, makePacket } from "../storage/shared-suite.js";

vi.mock("3am-diagnosis", () => ({
  diagnose: vi.fn().mockResolvedValue({
    summary: {
      what_happened: "Stripe 429s caused checkout 500s.",
      root_cause_hypothesis: "Retry amplification exhausted the checkout path.",
    },
    recommendation: {
      immediate_action: "Disable the retry loop.",
      action_rationale_short: "It cuts the overload at the source.",
      do_not: "Do not increase timeout budgets.",
    },
    reasoning: {
      causal_chain: [
        { type: "external", title: "Stripe 429", detail: "Rate limiting started." },
        { type: "system", title: "Retry loop", detail: "The worker retried too aggressively." },
        { type: "impact", title: "Checkout 500", detail: "The route failed for customers." },
      ],
    },
    operator_guidance: {
      watch_items: [{ label: "Error rate", state: "must fall", status: "watch" }],
      operator_checks: ["Confirm 429s flatten within 60s."],
    },
    confidence: {
      confidence_assessment: "High confidence.",
      uncertainty: "Stripe quota internals are not visible.",
    },
    metadata: {
      incident_id: "inc_queue_001",
      packet_id: "pkt_queue_001",
      model: "claude-sonnet-4-6",
      prompt_version: "v5",
      created_at: "2026-03-09T03:10:00Z",
    },
  }),
  generateConsoleNarrative: vi.fn().mockResolvedValue({
    headline: "Stripe retry amplification is driving checkout failures",
    whyThisAction: "Disabling the retry loop removes the extra dependency pressure immediately.",
    confidenceSummary: {
      basis: "429s and checkout failures move together in the same window.",
      risk: "If retries remain enabled, pressure returns quickly.",
    },
    proofCards: [
      { id: "trigger", label: "External Trigger", summary: "Stripe 429s are the starting signal." },
      { id: "design_gap", label: "Design Gap", summary: "Retries amplify the dependency failure." },
      { id: "recovery", label: "Recovery Signal", summary: "Recovery is pending once retries stop." },
    ],
    qa: {
      question: "Why is checkout failing?",
      answer: "Stripe started returning 429s and the retry loop amplified the failure.",
      answerEvidenceRefs: [],
      evidenceBindings: [],
      followups: [{ question: "Did the 429s stop?", targetEvidenceKinds: ["logs"] }],
      noAnswerReason: "Mocked worker test response.",
    },
    sideNotes: [
      { title: "Confidence", text: "High confidence from aligned traces and logs.", kind: "confidence" },
    ],
    absenceEvidence: [],
    metadata: {
      model: "claude-haiku-4-5-20251001",
      prompt_version: "narrative-v1",
      stage1_packet_id: "pkt_queue_001",
      created_at: "2026-03-09T03:11:00Z",
    },
  }),
}));

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    RECEIVER_AUTH_TOKEN: string;
    ANTHROPIC_API_KEY?: string;
  }
}

async function seedIncident(overrides: { withDiagnosis?: boolean } = {}): Promise<string> {
  const storage = new D1StorageAdapter(env.DB);
  await storage.migrate();
  const telemetry = new D1TelemetryAdapter(env.DB);
  await telemetry.migrate();

  const packet = makePacket({
    incidentId: "inc_queue_001",
    packetId: "pkt_queue_001",
  });
  await storage.createIncident(packet, makeMembership());
  if (overrides.withDiagnosis) {
    await storage.appendDiagnosis(packet.incidentId, {
      summary: {
        what_happened: "Already diagnosed.",
        root_cause_hypothesis: "No-op rerun.",
      },
      recommendation: {
        immediate_action: "Observe.",
        action_rationale_short: "No further action.",
        do_not: "Do not enqueue duplicate work.",
      },
      reasoning: { causal_chain: [] },
      operator_guidance: { watch_items: [], operator_checks: [] },
      confidence: {
        confidence_assessment: "High confidence.",
        uncertainty: "None.",
      },
      metadata: {
        incident_id: packet.incidentId,
        packet_id: packet.packetId,
        model: "claude-haiku-4-5-20251001",
        prompt_version: "v5",
        created_at: "2026-03-09T03:09:00Z",
      },
    });
  }
  return packet.incidentId;
}

describe("Cloudflare Queue consumer", () => {
  it("retries the message when diagnosis execution fails", async () => {
    const { diagnose } = await import("3am-diagnosis");
    vi.mocked(diagnose).mockRejectedValueOnce(new Error("Anthropic timeout"));
    const incidentId = await seedIncident();

    const batch = createMessageBatch("3am-diagnosis", [
      { id: "msg-retry", timestamp: new Date(), attempts: 1, body: { incidentId } },
    ]);
    const ctx = createExecutionContext();

    await worker.queue(batch, { DB: env.DB }, ctx);

    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: "msg-retry" }]);
  });

  it("acks malformed queue payloads without retrying", async () => {
    const batch = createMessageBatch("3am-diagnosis", [
      { id: "msg-bad", timestamp: new Date(), attempts: 1, body: { incidentId: "" } },
    ]);
    const ctx = createExecutionContext();

    await worker.queue(batch, { DB: env.DB }, ctx);

    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["msg-bad"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("acks duplicate work when the incident is already diagnosed", async () => {
    const incidentId = await seedIncident({ withDiagnosis: true });
    const batch = createMessageBatch("3am-diagnosis", [
      { id: "msg-skip", timestamp: new Date(), attempts: 1, body: { incidentId } },
    ]);
    const ctx = createExecutionContext();

    await worker.queue(batch, { DB: env.DB }, ctx);

    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["msg-skip"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("reruns stage 2 narrative when requested explicitly", async () => {
    const incidentId = await seedIncident({ withDiagnosis: true });
    const batch = createMessageBatch("3am-diagnosis", [
      { id: "msg-narrative", timestamp: new Date(), attempts: 1, body: { incidentId, mode: "narrative" } },
    ]);
    const ctx = createExecutionContext();

    await worker.queue(batch, { DB: env.DB }, ctx);

    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["msg-narrative"]);
    expect(result.retryMessages).toEqual([]);

    const storage = new D1StorageAdapter(env.DB);
    const incident = await storage.getIncident(incidentId);
    expect(incident?.consoleNarrative?.headline).toContain("Stripe retry amplification");
  });
});
