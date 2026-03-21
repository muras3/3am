import { describe, expect, it } from "vitest";
import { buildNarrativePrompt } from "../narrative-prompt.js";
import { rateLimit as rsFixture } from "../__fixtures__/reasoning-structures.js";
import { rateLimit as drFixture } from "../__fixtures__/diagnosis-results.js";

describe("buildNarrativePrompt", () => {
  const prompt = buildNarrativePrompt(drFixture, rsFixture);

  it("includes stage 1 diagnosis data", () => {
    expect(prompt).toContain(drFixture.summary.what_happened);
    expect(prompt).toContain(drFixture.recommendation.immediate_action);
    expect(prompt).toContain(drFixture.confidence.confidence_assessment);
  });

  it("includes receiver context data", () => {
    expect(prompt).toContain("checkout-orchestrator");
    expect(prompt).toContain("trigger [confirmed]");
    expect(prompt).toContain("recovery [pending]");
  });

  it("includes known evidence IDs", () => {
    expect(prompt).toContain("tid:a3f8:sid:pay429");
    expect(prompt).toContain("worker_pool_in_use::checkout-orchestrator");
  });

  it("includes absence candidates", () => {
    expect(prompt).toContain("no-backoff");
    expect(prompt).toContain("backoff");
    expect(prompt).toContain("matchCount=0");
  });

  it("includes the concrete ref constraint", () => {
    expect(prompt).toContain("ONLY use IDs from");
    expect(prompt).toContain("Do NOT invent IDs");
  });

  it("includes the wording-only directive", () => {
    expect(prompt).toContain("WORDING ONLY");
    expect(prompt).toContain("Do not make judgments");
  });

  it("includes output JSON template", () => {
    expect(prompt).toContain('"headline"');
    expect(prompt).toContain('"evidenceBindings"');
    expect(prompt).toContain('"noAnswerReason"');
  });
});
