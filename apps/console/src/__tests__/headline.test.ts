import { describe, expect, it } from "vitest";
import { extractTitle } from "../lib/headline.js";

describe("extractTitle", () => {
  it("returns the first sentence when headline has supporting detail", () => {
    expect(
      extractTitle("CDN 503 cascade on /products. Origin recovered but cache kept serving errors."),
    ).toBe("CDN 503 cascade on /products.");
  });

  it("returns the whole headline when no sentence boundary exists", () => {
    expect(extractTitle("Stripe 429 cascade")).toBe("Stripe 429 cascade");
  });

  it("handles Japanese full-stop punctuation", () => {
    expect(extractTitle("CDN 503 cascade。Origin recovered after cache purge.")).toBe("CDN 503 cascade。");
  });
});
