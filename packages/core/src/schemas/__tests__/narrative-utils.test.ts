import { describe, expect, it } from "vitest";
import { isFollowupAnswerable } from "../narrative-utils.js";

describe("isFollowupAnswerable", () => {
  it("returns true when target kinds overlap with available", () => {
    expect(isFollowupAnswerable(
      { targetEvidenceKinds: ["traces", "logs"] },
      ["traces", "metrics"],
    )).toBe(true);
  });

  it("returns false when no overlap", () => {
    expect(isFollowupAnswerable(
      { targetEvidenceKinds: ["logs"] },
      ["traces", "metrics"],
    )).toBe(false);
  });

  it("returns false when available is empty", () => {
    expect(isFollowupAnswerable(
      { targetEvidenceKinds: ["traces"] },
      [],
    )).toBe(false);
  });

  it("returns true when all kinds match", () => {
    expect(isFollowupAnswerable(
      { targetEvidenceKinds: ["traces", "metrics", "logs"] },
      ["traces", "metrics", "logs"],
    )).toBe(true);
  });
});
