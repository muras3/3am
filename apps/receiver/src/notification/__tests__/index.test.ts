import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncidentPacket } from "3am-core";
import { MemoryAdapter } from "../../storage/adapters/memory.js";
import { setNotificationConfig } from "../config.js";

vi.mock("../slack.js", () => ({
  formatSlackIncidentCreated: vi.fn(() => ({ text: "slack-parent" })),
  formatSlackDiagnosisComplete: vi.fn(() => ({ text: "slack-followup" })),
  postSlackMessage: vi.fn(async () => ({ ok: true, ts: "1710000000.000100", channel: "C123" })),
}));

vi.mock("../discord.js", () => ({
  formatDiscordIncidentCreated: vi.fn(() => ({ content: "discord-parent" })),
  formatDiscordDiagnosisComplete: vi.fn(() => ({ content: "discord-followup" })),
  postDiscordMessage: vi.fn(async () => ({ ok: true, messageId: "m_123" })),
}));

import { notifyDiagnosisComplete, notifyIncidentCreated } from "../index.js";
import { formatSlackIncidentCreated, formatSlackDiagnosisComplete, postSlackMessage } from "../slack.js";
import { formatDiscordIncidentCreated, formatDiscordDiagnosisComplete, postDiscordMessage } from "../discord.js";

const mockSlackParent = vi.mocked(formatSlackIncidentCreated);
const mockSlackFollowup = vi.mocked(formatSlackDiagnosisComplete);
const mockSlackPost = vi.mocked(postSlackMessage);
const mockDiscordParent = vi.mocked(formatDiscordIncidentCreated);
const mockDiscordFollowup = vi.mocked(formatDiscordDiagnosisComplete);
const mockDiscordPost = vi.mocked(postDiscordMessage);

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

const diagnosisResult = {
  summary: {
    what_happened: "Checkout requests started failing.",
    root_cause_hypothesis: "Stripe rate limiting exhausted the retry budget.",
  },
  recommendation: {
    immediate_action: "Disable fixed retries against Stripe.",
    action_rationale_short: "Reduce downstream pressure immediately.",
    do_not: "Do not restart checkout pods.",
  },
  reasoning: {
    causal_chain: [
      { type: "external", title: "Stripe 429", detail: "Rate limit exceeded." },
      { type: "system", title: "Retry storm", detail: "Retries saturated workers." },
    ],
  },
  confidence: {
    confidence_assessment: "High confidence.",
    uncertainty: "Low uncertainty.",
  },
} as const;

describe("notification delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when no notification targets are configured", async () => {
    const storage = new MemoryAdapter();
    await notifyIncidentCreated(storage, makePacket(), "inc_000001");
    expect(mockSlackPost).not.toHaveBeenCalled();
    expect(mockDiscordPost).not.toHaveBeenCalled();
  });

  it("sends parent Slack notification and stores parent thread ref", async () => {
    const storage = new MemoryAdapter();
    await storage.createIncident(makePacket(), {
      telemetryScope: {
        windowStartMs: 0,
        windowEndMs: 0,
        detectTimeMs: 0,
        environment: "production",
        memberServices: [],
        dependencyServices: [],
      },
      spanMembership: [],
      anomalousSignals: [],
    });
    await setNotificationConfig(storage, {
      targets: [
        {
          id: "slack-default",
          provider: "slack",
          label: "Slack default",
          enabled: true,
          botToken: "xoxb-test",
          channelId: "C123",
        },
      ],
    });

    await notifyIncidentCreated(storage, makePacket(), "inc_000001");

    expect(mockSlackParent).toHaveBeenCalled();
    expect(mockSlackPost).toHaveBeenCalledTimes(1);
    const incident = await storage.getIncident("inc_000001");
    expect(incident?.notificationState?.deliveries[0]?.provider).toBe("slack");
  });

  it("sends diagnosis follow-up to stored Slack thread", async () => {
    const storage = new MemoryAdapter();
    await storage.createIncident(makePacket(), {
      telemetryScope: {
        windowStartMs: 0,
        windowEndMs: 0,
        detectTimeMs: 0,
        environment: "production",
        memberServices: [],
        dependencyServices: [],
      },
      spanMembership: [],
      anomalousSignals: [],
    });
    await setNotificationConfig(storage, {
      targets: [
        {
          id: "slack-default",
          provider: "slack",
          label: "Slack default",
          enabled: true,
          botToken: "xoxb-test",
          channelId: "C123",
        },
      ],
    });
    await notifyIncidentCreated(storage, makePacket(), "inc_000001");

    await notifyDiagnosisComplete(storage, makePacket(), "inc_000001", diagnosisResult);

    expect(mockSlackFollowup).toHaveBeenCalled();
    expect(mockSlackPost.mock.calls[1]?.[2]).toBe("1710000000.000100");
  });

  it("sends Discord parent notification and reply follow-up", async () => {
    const storage = new MemoryAdapter();
    await storage.createIncident(makePacket(), {
      telemetryScope: {
        windowStartMs: 0,
        windowEndMs: 0,
        detectTimeMs: 0,
        environment: "production",
        memberServices: [],
        dependencyServices: [],
      },
      spanMembership: [],
      anomalousSignals: [],
    });
    await setNotificationConfig(storage, {
      targets: [
        {
          id: "discord-default",
          provider: "discord",
          label: "Discord default",
          enabled: true,
          webhookUrl: "https://discord.com/api/webhooks/1/2",
        },
      ],
    });

    await notifyIncidentCreated(storage, makePacket(), "inc_000001");
    await notifyDiagnosisComplete(storage, makePacket(), "inc_000001", diagnosisResult);

    expect(mockDiscordParent).toHaveBeenCalled();
    expect(mockDiscordFollowup).toHaveBeenCalled();
    expect(mockDiscordPost.mock.calls[1]?.[2]).toBe("m_123");
  });
});
