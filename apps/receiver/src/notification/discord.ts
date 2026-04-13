import type {
  DiagnosisNotificationPayload,
  DiscordTargetConfig,
  IncidentCreatedNotificationPayload,
} from "./types.js";

const EMBED_COLOR = 0xe85d3a;
const MAX_SIGNALS = 5;
const MAX_CHAIN = 4;

export interface DiscordPostResult {
  ok: boolean;
  error?: string;
  messageId?: string;
}

export function formatDiscordIncidentCreated(
  payload: IncidentCreatedNotificationPayload,
): Record<string, unknown> {
  const shown = payload.triggerSignals.slice(0, MAX_SIGNALS);
  const overflow = payload.triggerSignals.length - shown.length;
  const fields: Array<Record<string, unknown>> = shown.map((signal, index) => ({
    name: `Signal ${index + 1}`,
    value: signal,
    inline: false,
  }));
  if (overflow > 0) {
    fields.push({ name: "More", value: `...and ${overflow} more`, inline: false });
  }

  return {
    content: `Incident ${payload.incidentId} detected`,
    embeds: [
      {
        color: EMBED_COLOR,
        title: `[${payload.severity.toUpperCase()}] Incident ${payload.incidentId}`,
        description: `**${payload.service}** · ${payload.environment}`,
        url: payload.consoleUrl,
        fields: [
          ...fields,
          {
            name: "Diagnosis",
            value: "Diagnosing now. Follow-up will be posted as a reply to this message.",
            inline: false,
          },
        ],
        timestamp: payload.openedAt,
        footer: { text: "3am" },
      },
    ],
  };
}

export const formatDiscord = formatDiscordIncidentCreated;

export function formatDiscordDiagnosisComplete(
  payload: DiagnosisNotificationPayload,
): Record<string, unknown> {
  const chain = payload.causalChain.slice(0, MAX_CHAIN).map((step, index) => `${index + 1}. ${step}`).join("\n");

  return {
    content: `Diagnosis complete for ${payload.incidentId}`,
    embeds: [
      {
        color: EMBED_COLOR,
        title: payload.rootCauseHypothesis,
        description: chain || "No causal chain available.",
        url: payload.consoleUrl,
        fields: [
          { name: "Immediate action", value: payload.immediateAction, inline: false },
          { name: "Do not", value: payload.doNot, inline: false },
          { name: "Confidence", value: payload.confidence, inline: false },
        ],
        footer: { text: "3am diagnosis" },
      },
    ],
  };
}

export async function postDiscordMessage(
  target: DiscordTargetConfig,
  body: Record<string, unknown>,
  replyToMessageId?: string,
): Promise<DiscordPostResult> {
  try {
    const url = new URL(target.webhookUrl);
    url.searchParams.set("wait", "true");
    const payload = replyToMessageId
      ? {
          ...body,
          message_reference: { message_id: replyToMessageId },
          allowed_mentions: { parse: [] },
        }
      : body;

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const json = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      return {
        ok: false,
        error: typeof json["message"] === "string" ? json["message"] : `http_${response.status}`,
      };
    }

    return {
      ok: true,
      messageId: typeof json["id"] === "string" ? json["id"] : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
