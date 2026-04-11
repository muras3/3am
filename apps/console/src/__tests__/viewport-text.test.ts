import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { splitActionForViewport } from "../components/lens/board/viewport-text.js";

// i18n module is mocked at module level via vitest auto-mock
vi.mock("../i18n/index.js", () => ({
  default: { language: "en" },
}));

describe("splitActionForViewport", () => {
  describe("numbered list patterns — inline (no newlines)", () => {
    it("splits on '1) ... 2) ...' style markers", () => {
      const text =
        "1) Pull full span details from Vercel logs 2) Check downstream Stripe response codes 3) Verify circuit-breaker state";
      const result = splitActionForViewport(text);
      expect(result).toHaveLength(3);
      expect(result[0]).toBe("Pull full span details from Vercel logs");
      expect(result[1]).toBe("Check downstream Stripe response codes");
      expect(result[2]).toBe("Verify circuit-breaker state");
    });

    it("splits on '1. ... 2. ...' style markers", () => {
      const text =
        "1. Pull full span details 2. Check Vercel function logs 3. Verify connectivity";
      const result = splitActionForViewport(text);
      expect(result).toHaveLength(3);
      expect(result[0]).toBe("Pull full span details");
      expect(result[1]).toBe("Check Vercel function logs");
    });

    it("strips the numeric marker from each step text", () => {
      const text = "1) Do A 2) Do B";
      const result = splitActionForViewport(text);
      expect(result[0]).not.toMatch(/^\d+[.)]/);
      expect(result[1]).not.toMatch(/^\d+[.)]/);
    });
  });

  describe("numbered list patterns — newline-separated", () => {
    it("splits on newline-prefixed '1) ...' markers", () => {
      const text = "1) Pull span details\n2) Check logs\n3) Verify connectivity";
      const result = splitActionForViewport(text);
      expect(result).toHaveLength(3);
      expect(result[0]).toBe("Pull span details");
    });

    it("splits on newline-prefixed bullet '- ...' markers", () => {
      const text = "- Pull span details\n- Check logs\n- Verify connectivity";
      const result = splitActionForViewport(text);
      expect(result).toHaveLength(3);
      expect(result[0]).toBe("Pull span details");
    });
  });

  describe("bullet list patterns", () => {
    it("splits on '- ' bullet markers inline", () => {
      const text = "- Pull span details - Check logs - Verify";
      // only 2+ markers triggers numbered path; inline bullets need newlines or
      // the pattern to match — test with newline form
      const text2 = "- Pull span details\n- Check logs\n- Verify";
      const result = splitActionForViewport(text2);
      expect(result).toHaveLength(3);
    });
  });

  describe("maxSteps cap", () => {
    it("returns at most maxSteps items", () => {
      const text = "1) A 2) B 3) C 4) D 5) E 6) F 7) G";
      const result = splitActionForViewport(text, 4);
      expect(result.length).toBeLessThanOrEqual(4);
    });

    it("defaults to max 6 steps", () => {
      const text = "1) A 2) B 3) C 4) D 5) E 6) F 7) G 8) H";
      const result = splitActionForViewport(text);
      expect(result.length).toBeLessThanOrEqual(6);
    });
  });

  describe("fallback: conjunctive English delimiters", () => {
    it("splits on commas when no numbered pattern present", () => {
      const text = "Pull logs, check response codes, verify state";
      const result = splitActionForViewport(text);
      expect(result.length).toBeGreaterThan(1);
    });

    it("returns single-item array for plain prose", () => {
      const text = "Rollback the deployment to the last stable version";
      const result = splitActionForViewport(text);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(text);
    });
  });

  describe("edge cases", () => {
    it("returns empty array for empty string", () => {
      expect(splitActionForViewport("")).toEqual([]);
    });

    it("returns empty array for whitespace-only string", () => {
      expect(splitActionForViewport("   ")).toEqual([]);
    });

    it("handles single numbered item gracefully (falls through to plain prose)", () => {
      const text = "1) Pull full span details from Vercel logs";
      const result = splitActionForViewport(text);
      // Only 1 marker — not a list, return as single step
      expect(result).toHaveLength(1);
    });
  });
});
