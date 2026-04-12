import { describe, it, expect } from "vitest";
import { detectProvider } from "../detect.js";

describe("detectProvider", () => {
  it("returns 'slack' for hooks.slack.com HTTPS URL", () => {
    const result = detectProvider(
      "https://hooks.slack.com/services/T123/B456/xxxyyyzzz"
    );
    expect(result).toBe("slack");
  });

  it("returns 'discord' for discord.com HTTPS URL", () => {
    const result = detectProvider(
      "https://discord.com/api/webhooks/123/abc"
    );
    expect(result).toBe("discord");
  });

  it("returns 'discord' for discordapp.com HTTPS URL", () => {
    const result = detectProvider(
      "https://discordapp.com/api/webhooks/123/abc"
    );
    expect(result).toBe("discord");
  });

  it("returns null for hostname spoof (evil.slack.com.attacker.io)", () => {
    const result = detectProvider(
      "https://evil.slack.com.attacker.io/x"
    );
    expect(result).toBeNull();
  });

  it("returns null for http:// Slack URL when allowInsecure is false (default)", () => {
    const result = detectProvider(
      "http://hooks.slack.com/services/T/B/x"
    );
    expect(result).toBeNull();
  });

  it("returns 'slack' for http:// Slack URL when allowInsecure is true", () => {
    const result = detectProvider(
      "http://hooks.slack.com/services/T/B/x",
      { allowInsecure: true }
    );
    expect(result).toBe("slack");
  });

  it("returns null for empty string", () => {
    const result = detectProvider("");
    expect(result).toBeNull();
  });

  it("returns null for non-URL string", () => {
    const result = detectProvider("not-a-url");
    expect(result).toBeNull();
  });

  it("returns null for unrecognized HTTPS URL", () => {
    const result = detectProvider("https://example.com/webhook");
    expect(result).toBeNull();
  });
});
