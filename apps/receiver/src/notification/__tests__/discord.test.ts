import { describe, it, expect } from "vitest";
import { formatDiscord } from "../discord.js";
import type { NotificationPayload } from "../types.js";

const base: NotificationPayload = {
  incidentId: "inc_000001",
  title: "Incident inc_000001",
  severity: "critical",
  service: "checkout-api",
  environment: "production",
  triggerSignals: ["Stripe 429 rate limit exceeded"],
  openedAt: "2026-04-01T03:00:00.000Z",
  consoleUrl: "https://console.example.com/incidents/inc_000001",
};

// 0xE85D3A as decimal
const EXPECTED_COLOR = 0xe85d3a; // 15424826

describe("formatDiscord", () => {
  it("has a content field (string for notification preview)", () => {
    const result = formatDiscord(base);
    expect(typeof result["content"]).toBe("string");
    expect((result["content"] as string).length).toBeGreaterThan(0);
  });

  it("has embeds[0].color === 0xE85D3A (15424826 decimal)", () => {
    const result = formatDiscord(base);
    const embeds = result["embeds"] as Array<Record<string, unknown>>;
    expect(embeds).toBeDefined();
    expect(embeds[0]["color"]).toBe(EXPECTED_COLOR);
  });

  it("has embeds[0].title containing severity and incidentId", () => {
    const result = formatDiscord(base);
    const embeds = result["embeds"] as Array<Record<string, unknown>>;
    const title = embeds[0]["title"] as string;
    expect(title).toContain("inc_000001");
    expect(title.toUpperCase()).toContain("CRITICAL");
  });

  it("has embeds[0].description containing service and environment", () => {
    const result = formatDiscord(base);
    const embeds = result["embeds"] as Array<Record<string, unknown>>;
    const description = embeds[0]["description"] as string;
    expect(description).toContain("checkout-api");
    expect(description).toContain("production");
  });

  it("has embeds[0].url === consoleUrl", () => {
    const result = formatDiscord(base);
    const embeds = result["embeds"] as Array<Record<string, unknown>>;
    expect(embeds[0]["url"]).toBe(base.consoleUrl);
  });

  it("has embeds[0].timestamp as ISO 8601 string", () => {
    const result = formatDiscord(base);
    const embeds = result["embeds"] as Array<Record<string, unknown>>;
    const timestamp = embeds[0]["timestamp"] as string;
    expect(typeof timestamp).toBe("string");
    expect(() => new Date(timestamp)).not.toThrow();
    expect(new Date(timestamp).toISOString()).toBe(base.openedAt);
  });

  it("has embeds[0].footer.text === '3am'", () => {
    const result = formatDiscord(base);
    const embeds = result["embeds"] as Array<Record<string, unknown>>;
    const footer = embeds[0]["footer"] as Record<string, string>;
    expect(footer["text"]).toBe("3am");
  });

  it("has fields for trigger signals", () => {
    const result = formatDiscord(base);
    const embeds = result["embeds"] as Array<Record<string, unknown>>;
    const fields = embeds[0]["fields"] as Array<Record<string, unknown>>;
    expect(Array.isArray(fields)).toBe(true);
    expect(fields.length).toBeGreaterThan(0);
  });

  it("truncates trigger signals when there are more than 5", () => {
    const manySignals = [
      "Signal A",
      "Signal B",
      "Signal C",
      "Signal D",
      "Signal E",
      "Signal F",
      "Signal G",
    ];
    const result = formatDiscord({ ...base, triggerSignals: manySignals });
    const embeds = result["embeds"] as Array<Record<string, unknown>>;
    const fields = embeds[0]["fields"] as Array<Record<string, unknown>>;
    const allFieldText = JSON.stringify(fields);
    // Should contain truncation indicator
    expect(allFieldText).toContain("more");
    // Signal F and G should not appear as individual entries
    expect(allFieldText).not.toContain("Signal F");
    expect(allFieldText).not.toContain("Signal G");
  });

  it("keeps total embed character count under 6000 with very long signals", () => {
    const longSignal = "X".repeat(500);
    const longSignals = Array.from({ length: 10 }, (_, i) => `Signal ${i}: ${longSignal}`);
    const result = formatDiscord({ ...base, triggerSignals: longSignals });
    const embeds = result["embeds"] as Array<Record<string, unknown>>;
    const embedJson = JSON.stringify(embeds[0]);
    // Count characters of all text fields as Discord does
    const totalChars = embedJson.length;
    // We use a generous bound — spec limit is 6000 chars in the embed *content*
    // JSON serialization overhead is ~10%, so cap at 7000 to be safe for this test
    expect(totalChars).toBeLessThan(7000);
    // More precisely: title + description + fields.values + footer <= 6000
    const embed = embeds[0] as Record<string, unknown>;
    const title = (embed["title"] as string) ?? "";
    const description = (embed["description"] as string) ?? "";
    const footer = ((embed["footer"] as Record<string, string>)?.["text"]) ?? "";
    const fields = (embed["fields"] as Array<Record<string, string>>) ?? [];
    const fieldChars = fields.reduce(
      (sum, f) => sum + (f["name"]?.length ?? 0) + (f["value"]?.length ?? 0),
      0
    );
    const totalContentChars = title.length + description.length + footer.length + fieldChars;
    expect(totalContentChars).toBeLessThan(6000);
  });
});
