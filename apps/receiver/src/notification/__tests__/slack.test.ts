import { describe, it, expect } from "vitest";
import { formatSlack } from "../slack.js";
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

describe("formatSlack", () => {
  it("has a non-empty text field (fallback for notifications)", () => {
    const result = formatSlack(base);
    expect(typeof result["text"]).toBe("string");
    expect((result["text"] as string).length).toBeGreaterThan(0);
  });

  it("has attachments[0].color === '#E85D3A'", () => {
    const result = formatSlack(base);
    const attachments = result["attachments"] as Array<Record<string, unknown>>;
    expect(attachments).toBeDefined();
    expect(attachments[0]["color"]).toBe("#E85D3A");
  });

  it("has a blocks array inside attachments[0] with at least 4 blocks", () => {
    const result = formatSlack(base);
    const attachments = result["attachments"] as Array<Record<string, unknown>>;
    const blocks = attachments[0]["blocks"] as unknown[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
  });

  it("includes a section block with bold title", () => {
    const result = formatSlack(base);
    const attachments = result["attachments"] as Array<Record<string, unknown>>;
    const blocks = attachments[0]["blocks"] as Array<Record<string, unknown>>;
    const sectionBlocks = blocks.filter((b) => b["type"] === "section");
    expect(sectionBlocks.length).toBeGreaterThanOrEqual(1);
    const firstSection = sectionBlocks[0] as Record<string, unknown>;
    const text = firstSection["text"] as Record<string, string>;
    expect(text["text"]).toContain("inc_000001");
    expect(text["text"]).toContain("*");
  });

  it("includes a fields section with Service and Environment", () => {
    const result = formatSlack(base);
    const attachments = result["attachments"] as Array<Record<string, unknown>>;
    const blocks = attachments[0]["blocks"] as Array<Record<string, unknown>>;
    const fieldsBlock = blocks.find(
      (b) => b["type"] === "section" && Array.isArray(b["fields"])
    ) as Record<string, unknown> | undefined;
    expect(fieldsBlock).toBeDefined();
    const fields = fieldsBlock!["fields"] as Array<Record<string, string>>;
    const fieldTexts = fields.map((f) => f["text"]).join(" ");
    expect(fieldTexts).toContain("checkout-api");
    expect(fieldTexts).toContain("production");
  });

  it("includes an actions block with a button linking to consoleUrl", () => {
    const result = formatSlack(base);
    const attachments = result["attachments"] as Array<Record<string, unknown>>;
    const blocks = attachments[0]["blocks"] as Array<Record<string, unknown>>;
    const actionsBlock = blocks.find((b) => b["type"] === "actions") as
      | Record<string, unknown>
      | undefined;
    expect(actionsBlock).toBeDefined();
    const elements = actionsBlock!["elements"] as Array<Record<string, unknown>>;
    expect(elements.length).toBeGreaterThan(0);
    const button = elements[0] as Record<string, unknown>;
    expect(button["type"]).toBe("button");
    const url = (button["url"] as string) ?? (button["action_id"] as string);
    // URL may be in button.url or nested in value
    const allText = JSON.stringify(button);
    expect(allText).toContain("console.example.com");
  });

  it("includes a context block (footer with timestamp)", () => {
    const result = formatSlack(base);
    const attachments = result["attachments"] as Array<Record<string, unknown>>;
    const blocks = attachments[0]["blocks"] as Array<Record<string, unknown>>;
    const contextBlock = blocks.find((b) => b["type"] === "context") as
      | Record<string, unknown>
      | undefined;
    expect(contextBlock).toBeDefined();
  });

  it("maps severity to correct emoji: critical→🔴, high→🟠, medium→🟡, low→🔵", () => {
    const severityEmojis: Array<[string, string]> = [
      ["critical", "🔴"],
      ["high", "🟠"],
      ["medium", "🟡"],
      ["low", "🔵"],
    ];
    for (const [severity, emoji] of severityEmojis) {
      const result = formatSlack({ ...base, severity });
      const text = result["text"] as string;
      expect(text).toContain(emoji);
    }
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
    const result = formatSlack({ ...base, triggerSignals: manySignals });
    const allText = JSON.stringify(result);
    // Should contain "...and" truncation indicator
    expect(allText).toContain("more");
    // Should NOT contain Signal F or G individually
    expect(allText).not.toContain("Signal F");
    expect(allText).not.toContain("Signal G");
  });
});
