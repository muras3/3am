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

  describe("title phrase fits UI width (≤60 chars)", () => {
    const wellStructuredHeadlines = [
      "Stripe 429 rate-limit cascade hit checkout. Retries exhausted connection pool within 2 min.",
      "CDN 503 cascade on /products. Origin recovered but cache kept serving stale errors.",
      "DB migration lock contention on users table. Queries queued for 45s causing timeouts.",
      "Secrets rotation partial failure on API keys. 2 of 4 instances serving with expired creds.",
      "Upstream CDN stale cache poison on /products. 503s persisted after origin recovery.",
    ];

    for (const headline of wellStructuredHeadlines) {
      it(`extracts ≤60-char title from: "${headline.slice(0, 50)}..."`, () => {
        const title = extractTitle(headline);
        expect(title.length).toBeLessThanOrEqual(60);
        expect(title).toMatch(/\.$/);
      });
    }
  });
});
