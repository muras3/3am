/**
 * Tests for claim token sign-in links in diagnosis-complete notifications.
 *
 * Verifies:
 * 1. Diagnosis notification includes a Console URL with #claim=TOKEN
 * 2. The claim is stored with a 5-hour TTL
 * 3. If claim minting fails, the notification still posts with a plain URL (graceful degradation)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncidentPacket, DiagnosisResult } from "3am-core";
import { MemoryAdapter } from "../../storage/adapters/memory.js";
import { SETTINGS_KEY_NOTIFICATION_CONFIG } from "../../notification/config.js";
import { CLAIM_KEY_PREFIX, NOTIFICATION_CLAIM_TTL_MS } from "../../auth/claim.js";
import { buildConsoleUrl } from "../../notification/index.js";

// ── Mock fetch so Slack/Discord posts don't leave the process ──

const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", mockFetch);

// ── Helpers ──

function makePacket(incidentId: string): IncidentPacket {
  return {
    schemaVersion: "incident-packet/v1alpha1",
    packetId: `pkt_${incidentId}`,
    incidentId,
    openedAt: "2026-03-08T00:00:00Z",
    window: {
      start: "2026-03-08T00:00:00Z",
      detect: "2026-03-08T00:01:10Z",
      end: "2026-03-08T00:08:00Z",
    },
    scope: {
      environment: "production",
      primaryService: "web",
      affectedServices: ["web"],
      affectedRoutes: ["/checkout"],
      affectedDependencies: ["stripe"],
    },
    triggerSignals: [
      {
        signal: "span_error_rate",
        firstSeenAt: "2026-03-08T00:01:10Z",
        entity: "web",
      },
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
  } as IncidentPacket;
}

function makeDiagnosisResult(): DiagnosisResult {
  return {
    summary: { root_cause_hypothesis: "Database connection pool exhausted" },
    recommendation: {
      immediate_action: "Restart the connection pool",
      do_not: "Do not restart the database",
    },
    confidence: { confidence_assessment: "High" },
    reasoning: {
      causal_chain: [
        { title: "Traffic spike", detail: "Traffic spike occurred" },
        { title: "Pool exhaustion", detail: "Connection pool ran out" },
      ],
    },
  } as DiagnosisResult;
}

function slackConfig() {
  return {
    targets: [
      {
        id: "slack-1",
        provider: "slack" as const,
        label: "Test Slack",
        enabled: true,
        botToken: "xoxb-test",
        channelId: "C12345",
      },
    ],
  };
}

function discordWebhookConfig() {
  return {
    targets: [
      {
        id: "discord-1",
        provider: "discord" as const,
        label: "Test Discord",
        enabled: true,
        mode: "webhook" as const,
        webhookUrl: "https://discord.com/api/webhooks/123/abc",
      },
    ],
  };
}

async function seedIncidentWithDelivery(
  storage: MemoryAdapter,
  incidentId: string,
  provider: "slack" | "discord",
): Promise<void> {
  const packet = makePacket(incidentId);
  await storage.createIncident(packet, {
    telemetryScope: {
      windowStartMs: 0,
      windowEndMs: 1000,
      detectTimeMs: 500,
      environment: "production",
      memberServices: ["web"],
      dependencyServices: [],
    },
    spanMembership: [],
    anomalousSignals: [],
  });

  if (provider === "slack") {
    await storage.updateNotificationState(incidentId, {
      deliveries: [
        {
          provider: "slack",
          targetId: "slack-1",
          parentTs: "1234567890.123456",
          channelId: "C12345",
          parentNotifiedAt: new Date().toISOString(),
        },
      ],
    });
  } else {
    await storage.updateNotificationState(incidentId, {
      deliveries: [
        {
          provider: "discord",
          targetId: "discord-1",
          messageId: "msg-001",
          parentNotifiedAt: new Date().toISOString(),
        },
      ],
    });
  }
}

// ── Tests ──

describe("buildConsoleUrl", () => {
  it("returns plain URL when no claim token", () => {
    const url = buildConsoleUrl("inc_000001");
    expect(url).toBe("http://localhost:3333/incidents/inc_000001");
    expect(url).not.toContain("#claim=");
  });

  it("appends #claim=TOKEN when claim token provided", () => {
    const url = buildConsoleUrl("inc_000001", "my-claim-token");
    expect(url).toBe("http://localhost:3333/incidents/inc_000001#claim=my-claim-token");
  });
});

describe("diagnosis notification with claim sign-in link", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("includes #claim= in the Slack diagnosis notification URL", async () => {
    // Slack API returns success for the thread reply
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, ts: "1234567890.999999", channel: "C12345" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const storage = new MemoryAdapter();
    await storage.setSettings(SETTINGS_KEY_NOTIFICATION_CONFIG, JSON.stringify(slackConfig()));
    await seedIncidentWithDelivery(storage, "inc_claim_001", "slack");

    // Dynamic import to pick up the mocked fetch
    const { notifyDiagnosisComplete } = await import("../../notification/index.js");
    await notifyDiagnosisComplete(storage, makePacket("inc_claim_001"), "inc_claim_001", makeDiagnosisResult());

    // The fetch call to Slack should contain a URL with #claim=
    expect(mockFetch).toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    const blocks = body["blocks"] as Array<Record<string, unknown>>;
    const actionsBlock = blocks.find((block) => block["type"] === "actions") as Record<string, unknown> | undefined;
    expect(actionsBlock).toBeDefined();
    const elements = actionsBlock!["elements"] as Array<Record<string, unknown>>;
    const buttonUrl = elements[0]!["url"] as string;
    expect(buttonUrl).toContain("#claim=");
    expect(buttonUrl).toMatch(/^http:\/\/localhost:3333\/incidents\/inc_claim_001#claim=.+$/);
  });

  it("includes #claim= in the Discord diagnosis notification URL", async () => {
    // Discord webhook returns success
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ id: "msg-reply-001" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const storage = new MemoryAdapter();
    await storage.setSettings(SETTINGS_KEY_NOTIFICATION_CONFIG, JSON.stringify(discordWebhookConfig()));
    await seedIncidentWithDelivery(storage, "inc_claim_002", "discord");

    const { notifyDiagnosisComplete } = await import("../../notification/index.js");
    await notifyDiagnosisComplete(storage, makePacket("inc_claim_002"), "inc_claim_002", makeDiagnosisResult());

    expect(mockFetch).toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    const embeds = body["embeds"] as Array<Record<string, unknown>>;
    const embedUrl = embeds[0]!["url"] as string;
    expect(embedUrl).toContain("#claim=");
    expect(embedUrl).toMatch(/^http:\/\/localhost:3333\/incidents\/inc_claim_002#claim=.+$/);
  });

  it("stores the claim with a 5-hour TTL", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, ts: "1234567890.999999", channel: "C12345" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const storage = new MemoryAdapter();
    await storage.setSettings(SETTINGS_KEY_NOTIFICATION_CONFIG, JSON.stringify(slackConfig()));
    await seedIncidentWithDelivery(storage, "inc_claim_003", "slack");

    const now = Date.now();
    const { notifyDiagnosisComplete } = await import("../../notification/index.js");
    await notifyDiagnosisComplete(storage, makePacket("inc_claim_003"), "inc_claim_003", makeDiagnosisResult());

    // Extract the claim token from the URL sent to Slack
    const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    const blocks = body["blocks"] as Array<Record<string, unknown>>;
    const actionsBlock = blocks.find((block) => block["type"] === "actions") as Record<string, unknown>;
    const elements = actionsBlock["elements"] as Array<Record<string, unknown>>;
    const buttonUrl = elements[0]!["url"] as string;
    const claimToken = buttonUrl.split("#claim=")[1]!;
    expect(claimToken.length).toBeGreaterThan(16);

    // Hash the token and look up the stored claim
    const { sha256 } = await import("../../auth/claim.js");
    const tokenHash = await sha256(claimToken);
    const storedRaw = await storage.getSettings(CLAIM_KEY_PREFIX + tokenHash);
    expect(storedRaw).toBeDefined();

    const stored = JSON.parse(storedRaw!) as { expiresAt: string };
    const expiresAt = Date.parse(stored.expiresAt);

    // 5 hours = 18_000_000 ms — allow 5s tolerance for test execution time
    const expectedExpiry = now + NOTIFICATION_CLAIM_TTL_MS;
    expect(Math.abs(expiresAt - expectedExpiry)).toBeLessThan(5000);
  });

  it("falls back to plain URL when claim minting fails", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, ts: "1234567890.999999", channel: "C12345" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const storage = new MemoryAdapter();
    await storage.setSettings(SETTINGS_KEY_NOTIFICATION_CONFIG, JSON.stringify(slackConfig()));
    await seedIncidentWithDelivery(storage, "inc_claim_004", "slack");

    // Sabotage setSettings so claim minting throws (but other operations still work).
    // We do this by wrapping setSettings to throw only for claim keys.
    const originalSetSettings = storage.setSettings.bind(storage);
    storage.setSettings = async (key: string, value: string) => {
      if (key.startsWith(CLAIM_KEY_PREFIX)) {
        throw new Error("storage write failed");
      }
      return originalSetSettings(key, value);
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { notifyDiagnosisComplete } = await import("../../notification/index.js");
    await notifyDiagnosisComplete(storage, makePacket("inc_claim_004"), "inc_claim_004", makeDiagnosisResult());

    // Should still post the notification
    expect(mockFetch).toHaveBeenCalled();

    // The URL should NOT contain a claim token — graceful degradation
    const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    const blocks = body["blocks"] as Array<Record<string, unknown>>;
    const actionsBlock = blocks.find((block) => block["type"] === "actions") as Record<string, unknown>;
    const elements = actionsBlock["elements"] as Array<Record<string, unknown>>;
    const buttonUrl = elements[0]!["url"] as string;
    expect(buttonUrl).toBe("http://localhost:3333/incidents/inc_claim_004");
    expect(buttonUrl).not.toContain("#claim=");

    // Should have logged a warning about the failed mint
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[notification] claim mint failed"),
      expect.any(String),
    );

    warnSpy.mockRestore();
  });
});

describe("NOTIFICATION_CLAIM_TTL_MS", () => {
  it("is 5 hours (18_000_000 ms)", () => {
    expect(NOTIFICATION_CLAIM_TTL_MS).toBe(5 * 60 * 60 * 1000);
  });
});
