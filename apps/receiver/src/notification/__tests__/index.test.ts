import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncidentPacket } from "@3am/core";

// Mock the sub-modules so we can assert calls without real HTTP
vi.mock("../detect.js", () => ({
  detectProvider: vi.fn(),
}));
vi.mock("../slack.js", () => ({
  formatSlack: vi.fn(() => ({ text: "slack-body" })),
}));
vi.mock("../discord.js", () => ({
  formatDiscord: vi.fn(() => ({ content: "discord-body" })),
}));
vi.mock("../webhook.js", () => ({
  sendWebhook: vi.fn(async () => ({ ok: true, status: 200 })),
}));

import { notifyIncidentCreated } from "../index.js";
import { detectProvider } from "../detect.js";
import { formatSlack } from "../slack.js";
import { formatDiscord } from "../discord.js";
import { sendWebhook } from "../webhook.js";

const mockDetect = vi.mocked(detectProvider);
const mockFormatSlack = vi.mocked(formatSlack);
const mockFormatDiscord = vi.mocked(formatDiscord);
const mockSendWebhook = vi.mocked(sendWebhook);

function makePacket(overrides?: Partial<IncidentPacket>): IncidentPacket {
  return {
    schemaVersion: "incident-packet/v1alpha1",
    packetId: "pkt_001",
    incidentId: "inc_000001",
    openedAt: "2026-04-01T12:00:00Z",
    signalSeverity: "critical",
    window: {
      start: "2026-04-01T11:55:00Z",
      detect: "2026-04-01T12:00:00Z",
      end: "2026-04-01T12:05:00Z",
    },
    scope: {
      environment: "production",
      primaryService: "checkout-api",
      affectedServices: ["checkout-api"],
      affectedRoutes: ["/checkout"],
      affectedDependencies: ["stripe"],
    },
    triggerSignals: [
      { signal: "HTTP 500 on /checkout", firstSeenAt: "2026-04-01T12:00:00Z", entity: "checkout-api" },
    ],
    evidence: {
      changedMetrics: [],
      representativeTraces: [],
      relevantLogs: [],
      platformEvents: [],
    },
    pointers: {
      traceRefs: [],
      logRefs: [],
      metricRefs: [],
      platformLogRefs: [],
    },
    ...overrides,
  };
}

describe("notifyIncidentCreated", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("does nothing when NOTIFICATION_WEBHOOK_URL is not set", async () => {
    delete process.env["NOTIFICATION_WEBHOOK_URL"];
    await notifyIncidentCreated(makePacket(), "inc_000001");
    expect(mockDetect).not.toHaveBeenCalled();
    expect(mockSendWebhook).not.toHaveBeenCalled();
  });

  it("sends Slack notification for Slack webhook URL", async () => {
    process.env["NOTIFICATION_WEBHOOK_URL"] = "https://hooks.slack.com/services/T/B/x";
    mockDetect.mockReturnValue("slack");

    await notifyIncidentCreated(makePacket(), "inc_000001");

    expect(mockDetect).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/T/B/x",
      { allowInsecure: false },
    );
    expect(mockFormatSlack).toHaveBeenCalled();
    expect(mockFormatDiscord).not.toHaveBeenCalled();
    expect(mockSendWebhook).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/T/B/x",
      { text: "slack-body" },
    );
  });

  it("sends Discord notification for Discord webhook URL", async () => {
    process.env["NOTIFICATION_WEBHOOK_URL"] = "https://discord.com/api/webhooks/123/abc";
    mockDetect.mockReturnValue("discord");

    await notifyIncidentCreated(makePacket(), "inc_000001");

    expect(mockFormatDiscord).toHaveBeenCalled();
    expect(mockFormatSlack).not.toHaveBeenCalled();
    expect(mockSendWebhook).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/123/abc",
      { content: "discord-body" },
    );
  });

  it("respects ALLOW_INSECURE_DEV_MODE for http URLs", async () => {
    process.env["NOTIFICATION_WEBHOOK_URL"] = "http://localhost:3099/webhook";
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    mockDetect.mockReturnValue(null); // localhost won't match Slack/Discord

    await notifyIncidentCreated(makePacket(), "inc_000001");

    expect(mockDetect).toHaveBeenCalledWith(
      "http://localhost:3099/webhook",
      { allowInsecure: true },
    );
  });

  it("skips when detectProvider returns null", async () => {
    process.env["NOTIFICATION_WEBHOOK_URL"] = "https://example.com/webhook";
    mockDetect.mockReturnValue(null);

    await notifyIncidentCreated(makePacket(), "inc_000001");

    expect(mockSendWebhook).not.toHaveBeenCalled();
  });

  it("uses CONSOLE_BASE_URL for console link", async () => {
    process.env["NOTIFICATION_WEBHOOK_URL"] = "https://hooks.slack.com/services/T/B/x";
    process.env["CONSOLE_BASE_URL"] = "https://app.3am.dev";
    mockDetect.mockReturnValue("slack");

    await notifyIncidentCreated(makePacket(), "inc_000001");

    const payloadArg = mockFormatSlack.mock.calls[0]![0]!;
    expect(payloadArg.consoleUrl).toBe("https://app.3am.dev/incidents/inc_000001");
  });

  it("defaults CONSOLE_BASE_URL to http://localhost:3333", async () => {
    process.env["NOTIFICATION_WEBHOOK_URL"] = "https://hooks.slack.com/services/T/B/x";
    delete process.env["CONSOLE_BASE_URL"];
    mockDetect.mockReturnValue("slack");

    await notifyIncidentCreated(makePacket(), "inc_000001");

    const payloadArg = mockFormatSlack.mock.calls[0]![0]!;
    expect(payloadArg.consoleUrl).toBe("http://localhost:3333/incidents/inc_000001");
  });

  it("maps packet fields to NotificationPayload correctly", async () => {
    process.env["NOTIFICATION_WEBHOOK_URL"] = "https://hooks.slack.com/services/T/B/x";
    mockDetect.mockReturnValue("slack");

    const packet = makePacket({
      signalSeverity: "high",
      scope: {
        environment: "staging",
        primaryService: "payment-svc",
        affectedServices: ["payment-svc"],
        affectedRoutes: ["/pay"],
        affectedDependencies: [],
      },
      triggerSignals: [
        { signal: "Latency spike on /pay", firstSeenAt: "2026-04-01T12:00:00Z", entity: "payment-svc" },
        { signal: "Error rate > 5%", firstSeenAt: "2026-04-01T12:01:00Z", entity: "payment-svc" },
      ],
    });

    await notifyIncidentCreated(packet, "inc_000002");

    const payloadArg = mockFormatSlack.mock.calls[0]![0]!;
    expect(payloadArg.severity).toBe("high");
    expect(payloadArg.service).toBe("payment-svc");
    expect(payloadArg.environment).toBe("staging");
    expect(payloadArg.triggerSignals).toEqual(["Latency spike on /pay", "Error rate > 5%"]);
  });

  it("defaults severity to medium when signalSeverity is undefined", async () => {
    process.env["NOTIFICATION_WEBHOOK_URL"] = "https://hooks.slack.com/services/T/B/x";
    mockDetect.mockReturnValue("slack");

    const packet = makePacket({ signalSeverity: undefined });
    await notifyIncidentCreated(packet, "inc_000001");

    const payloadArg = mockFormatSlack.mock.calls[0]![0]!;
    expect(payloadArg.severity).toBe("medium");
  });

  it("never throws even if sendWebhook fails", async () => {
    process.env["NOTIFICATION_WEBHOOK_URL"] = "https://hooks.slack.com/services/T/B/x";
    mockDetect.mockReturnValue("slack");
    mockSendWebhook.mockRejectedValue(new Error("network down"));

    // Should NOT throw
    await expect(
      notifyIncidentCreated(makePacket(), "inc_000001"),
    ).resolves.toBeUndefined();
  });
});
