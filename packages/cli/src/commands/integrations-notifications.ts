import { createInterface } from "node:readline";
import {
  findReceiverCredentialByUrl,
  getReceiverCredential,
  loadCredentials,
  type ReceiverPlatform,
} from "./init/credentials.js";

type ProviderChoice = "slack" | "discord" | "both";

type NotificationConfig = {
  targets: Array<
    | {
        id: string;
        provider: "slack";
        label: string;
        enabled: boolean;
        botToken: string;
        channelId: string;
      }
    | {
        id: string;
        provider: "discord";
        label: string;
        enabled: boolean;
        webhookUrl: string;
      }
  >;
};

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function resolveReceiver(options: { receiverUrl?: string; authToken?: string }): Promise<{
  receiverUrl: string;
  authToken: string;
}> {
  if (options.receiverUrl && options.authToken) {
    return { receiverUrl: options.receiverUrl, authToken: options.authToken };
  }

  const creds = loadCredentials();
  if (options.receiverUrl) {
    const match = findReceiverCredentialByUrl(creds, options.receiverUrl);
    if (!match) {
      throw new Error("No receiver auth token found for the supplied --receiver-url");
    }
    return { receiverUrl: options.receiverUrl, authToken: match.authToken };
  }

  const candidates: ReceiverPlatform[] = ["vercel", "cloudflare"];
  for (const platform of candidates) {
    const match = getReceiverCredential(creds, platform);
    if (match) return { receiverUrl: match.url, authToken: match.authToken };
  }

  throw new Error("No deployed receiver found. Run `npx 3am deploy` first or pass --receiver-url and --auth-token.");
}

async function fetchJson<T>(url: string, init: RequestInit, errorPrefix: string): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) as T | { error?: string } : {} as T;
  if (!response.ok) {
    const message = typeof (body as { error?: string }).error === "string"
      ? (body as { error: string }).error
      : `${errorPrefix} failed with ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function chooseProvider(raw: string): ProviderChoice | null {
  if (raw === "slack" || raw === "discord" || raw === "both") return raw;
  if (raw === "s") return "slack";
  if (raw === "d") return "discord";
  if (raw === "b") return "both";
  return null;
}

export async function runIntegrationsNotifications(options: {
  receiverUrl?: string;
  authToken?: string;
  provider?: string;
  slackBotToken?: string;
  slackChannelId?: string;
  discordWebhookUrl?: string;
  yes?: boolean;
}): Promise<void> {
  const { receiverUrl, authToken } = await resolveReceiver(options);

  let provider = chooseProvider(options.provider ?? "");
  if (!provider) {
    provider = chooseProvider(
      await prompt("Provider [slack|discord|both] (default: both): ") || "both",
    );
  }
  if (!provider) throw new Error("provider must be slack, discord, or both");

  const config: NotificationConfig = { targets: [] };

  if (provider === "slack" || provider === "both") {
    const botToken = options.slackBotToken ?? await prompt("Slack Bot Token (xoxb-...): ");
    const channelId = options.slackChannelId ?? await prompt("Slack Channel ID (C... or G...): ");
    if (!botToken || !channelId) {
      throw new Error("Slack configuration requires bot token and channel ID");
    }
    config.targets.push({
      id: "slack-default",
      provider: "slack",
      label: "Slack default",
      enabled: true,
      botToken,
      channelId,
    });
  }

  if (provider === "discord" || provider === "both") {
    const webhookUrl = options.discordWebhookUrl ?? await prompt("Discord Webhook URL: ");
    if (!webhookUrl) {
      throw new Error("Discord configuration requires a webhook URL");
    }
    config.targets.push({
      id: "discord-default",
      provider: "discord",
      label: "Discord default",
      enabled: true,
      webhookUrl,
    });
  }

  process.stdout.write(`Saving notification integrations to ${receiverUrl} ...\n`);
  await fetchJson(
    `${receiverUrl}/api/integrations/notifications`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(config),
    },
    "save notification config",
  );

  process.stdout.write("Sending test notification ...\n");
  const result = await fetchJson<{ ok: boolean; sent: Array<{ targetId: string; provider: string }> }>(
    `${receiverUrl}/api/integrations/notifications/test`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    },
    "test notification",
  );

  const sentLabels = result.sent.map((target) => `${target.provider}:${target.targetId}`).join(", ");
  process.stdout.write(`Notification integrations ready: ${sentLabels}\n`);
}
