import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runIntegrationsNotifications } from "../commands/integrations-notifications.js";

describe("runIntegrationsNotifications", () => {
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  });

  it("saves Slack + Discord bot config and triggers a test notification", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          targets: [
            {
              id: "slack-default",
              provider: "slack",
              label: "Slack default",
              enabled: true,
              botToken: "xoxb-test",
              channelId: "C123",
            },
            {
              id: "discord-default",
              provider: "discord",
              label: "Discord default",
              enabled: true,
              mode: "bot",
              botToken: "discord-bot",
              channelId: "D123",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          ok: true,
          sent: [
            { provider: "slack", targetId: "slack-default" },
            { provider: "discord", targetId: "discord-default" },
          ],
        }),
      });
    globalThis.fetch = fetchMock as typeof fetch;

    const stdout: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;

    await runIntegrationsNotifications({
      receiverUrl: "https://receiver.example.com",
      authToken: "receiver-auth",
      provider: "both",
      slackBotToken: "xoxb-test",
      slackChannelId: "C123",
      discordBotToken: "discord-bot",
      discordChannelId: "D123",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [saveUrl, saveInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(saveUrl).toBe("https://receiver.example.com/api/integrations/notifications");
    expect(saveInit.method).toBe("PUT");
    expect(saveInit.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer receiver-auth",
    });
    expect(JSON.parse(String(saveInit.body))).toEqual({
      targets: [
        {
          id: "slack-default",
          provider: "slack",
          label: "Slack default",
          enabled: true,
          botToken: "xoxb-test",
          channelId: "C123",
        },
        {
          id: "discord-default",
          provider: "discord",
          label: "Discord default",
          enabled: true,
          mode: "bot",
          botToken: "discord-bot",
          channelId: "D123",
        },
      ],
    });

    const [testUrl, testInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(testUrl).toBe("https://receiver.example.com/api/integrations/notifications/test");
    expect(testInit.method).toBe("POST");
    expect(testInit.headers).toEqual({
      Authorization: "Bearer receiver-auth",
    });
    expect(stdout.join("")).toContain("Notification integrations ready: slack:slack-default, discord:discord-default");
  });

  it("supports Discord webhook mode explicitly", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ targets: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          ok: true,
          sent: [{ provider: "discord", targetId: "discord-default" }],
        }),
      });
    globalThis.fetch = fetchMock as typeof fetch;

    await runIntegrationsNotifications({
      receiverUrl: "https://receiver.example.com",
      authToken: "receiver-auth",
      provider: "discord",
      discordWebhookUrl: "https://discord.com/api/webhooks/1/2",
    });

    const [, saveInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(saveInit.body))).toEqual({
      targets: [
        {
          id: "discord-default",
          provider: "discord",
          label: "Discord default",
          enabled: true,
          mode: "webhook",
          webhookUrl: "https://discord.com/api/webhooks/1/2",
        },
      ],
    });
  });
});
