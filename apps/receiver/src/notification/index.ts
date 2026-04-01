import type { IncidentPacket } from "@3amoncall/core";
import type { NotificationPayload } from "./types.js";
import { detectProvider } from "./detect.js";
import { formatSlack } from "./slack.js";
import { formatDiscord } from "./discord.js";
import { sendWebhook } from "./webhook.js";

function buildPayload(packet: IncidentPacket, consoleUrl: string): NotificationPayload {
  return {
    incidentId: packet.incidentId,
    title: `Incident ${packet.incidentId}`,
    severity: packet.signalSeverity ?? "medium",
    service: packet.scope.primaryService,
    environment: packet.scope.environment,
    triggerSignals: packet.triggerSignals.map((s) => s.signal),
    openedAt: packet.openedAt,
    consoleUrl,
  };
}

/**
 * Fire-and-forget notification for new incident creation.
 * Reads NOTIFICATION_WEBHOOK_URL from env. If unset, does nothing.
 * Never throws — all errors are caught and logged.
 */
export async function notifyIncidentCreated(
  packet: IncidentPacket,
  incidentId: string,
): Promise<void> {
  try {
    const webhookUrl = process.env["NOTIFICATION_WEBHOOK_URL"];
    if (!webhookUrl) return;

    const allowInsecure = process.env["ALLOW_INSECURE_DEV_MODE"] === "true";
    const provider = detectProvider(webhookUrl, { allowInsecure });
    if (!provider) {
      console.warn(
        `[notification] NOTIFICATION_WEBHOOK_URL is not a recognized Slack/Discord webhook. Skipping.`,
      );
      return;
    }

    const consoleBaseUrl = process.env["CONSOLE_BASE_URL"] || "http://localhost:3333";
    const consoleUrl = `${consoleBaseUrl}/incidents/${incidentId}`;
    const payload = buildPayload(packet, consoleUrl);

    const body = provider === "slack" ? formatSlack(payload) : formatDiscord(payload);
    await sendWebhook(webhookUrl, body);
  } catch (err) {
    console.warn(`[notification] unexpected error:`, err instanceof Error ? err.message : err);
  }
}
