import type {
  DiagnosisNotificationPayload,
  DiscordBotTargetConfig,
  DiscordTargetConfig,
  DiscordWebhookTargetConfig,
  IncidentCreatedNotificationPayload,
} from "./types.js";

const EMBED_COLOR = 0xe85d3a;
const MAX_SIGNALS = 5;
const MAX_CHAIN = 4;

const DISCORD_API_BASE = "https://discord.com/api/v10";

export interface DiscordPostResult {
  ok: boolean;
  error?: string;
  messageId?: string;
  threadId?: string;
}

function incidentEmbed(payload: IncidentCreatedNotificationPayload): Record<string, unknown> {
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
            value: "Diagnosing now. Follow-up will be posted in this thread.",
            inline: false,
          },
        ],
        timestamp: payload.openedAt,
        footer: { text: "3am" },
      },
    ],
  };
}

export function formatDiscordIncidentCreated(
  payload: IncidentCreatedNotificationPayload,
): Record<string, unknown> {
  return incidentEmbed(payload);
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

async function parseDiscordJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

async function postDiscordWebhookMessage(
  target: DiscordWebhookTargetConfig,
  body: Record<string, unknown>,
  replyToMessageId?: string,
): Promise<DiscordPostResult> {
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

  const json = await parseDiscordJson(response);
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
}

async function discordBotRequest(
  target: DiscordBotTargetConfig,
  path: string,
  init: RequestInit,
): Promise<Response> {
  return fetch(`${DISCORD_API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${target.botToken}`,
      ...(init.headers ?? {}),
    },
  });
}

async function createDiscordThread(
  target: DiscordBotTargetConfig,
  messageId: string,
  incidentId: string,
): Promise<{ ok: boolean; threadId?: string; error?: string }> {
  const response = await discordBotRequest(
    target,
    `/channels/${target.channelId}/messages/${messageId}/threads`,
    {
      method: "POST",
      body: JSON.stringify({
        name: `incident-${incidentId}`,
        auto_archive_duration: 1440,
      }),
    },
  );
  const json = await parseDiscordJson(response);
  if (!response.ok) {
    return {
      ok: false,
      error: typeof json["message"] === "string" ? json["message"] : `http_${response.status}`,
    };
  }
  return {
    ok: true,
    threadId: typeof json["id"] === "string" ? json["id"] : undefined,
  };
}

async function postDiscordBotMessage(
  target: DiscordBotTargetConfig,
  body: Record<string, unknown>,
  threadId?: string,
): Promise<DiscordPostResult> {
  const channelId = threadId ?? target.channelId;
  const response = await discordBotRequest(target, `/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const json = await parseDiscordJson(response);
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
}

export async function postDiscordMessage(
  target: DiscordTargetConfig,
  body: Record<string, unknown>,
  delivery?: { messageId?: string; threadId?: string; incidentId?: string },
): Promise<DiscordPostResult> {
  try {
    if (target.mode === "bot") {
      if (!delivery?.threadId && delivery?.messageId && delivery.incidentId) {
        const thread = await createDiscordThread(target, delivery.messageId, delivery.incidentId);
        if (!thread.ok) {
          return { ok: false, error: thread.error };
        }
        const posted = await postDiscordBotMessage(target, body, thread.threadId);
        return { ...posted, threadId: thread.threadId };
      }
      return postDiscordBotMessage(target, body, delivery?.threadId);
    }

    return postDiscordWebhookMessage(target, body, delivery?.messageId);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function sendDiscordConnectivityProbe(target: DiscordTargetConfig): Promise<DiscordPostResult> {
  const payload = incidentEmbed({
    incidentId: "test_notification",
    severity: "medium",
    service: "3am",
    environment: "test",
    triggerSignals: ["Notification integration verified"],
    openedAt: new Date().toISOString(),
    consoleUrl: "http://localhost:3333",
  });

  if (target.mode === "bot") {
    const parent = await postDiscordBotMessage(target, payload);
    if (!parent.ok || !parent.messageId) return parent;
    const thread = await createDiscordThread(target, parent.messageId, "test_notification");
    if (!thread.ok || !thread.threadId) return { ok: false, error: thread.error };
    const followup = await postDiscordBotMessage(
      target,
      formatDiscordDiagnosisComplete({
        incidentId: "test_notification",
        severity: "medium",
        service: "3am",
        environment: "test",
        consoleUrl: "http://localhost:3333",
        rootCauseHypothesis: "Notification thread creation verified.",
        immediateAction: "None. This is a connectivity check.",
        doNot: "Do not page anyone for this test.",
        confidence: "High confidence.",
        causalChain: ["Parent message created", "Thread created", "Follow-up posted in thread"],
      }),
      thread.threadId,
    );
    return { ...followup, threadId: thread.threadId, messageId: parent.messageId };
  }

  return postDiscordWebhookMessage(target, payload);
}
