import type {
  DiagnosisNotificationPayload,
  IncidentCreatedNotificationPayload,
  SlackTargetConfig,
} from "./types.js";

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
};

const SLACK_API_URL = "https://slack.com/api/chat.postMessage";
const MAX_SIGNALS = 5;
const MAX_CHAIN = 4;

export interface SlackPostResult {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

function buildIncidentText(payload: IncidentCreatedNotificationPayload): string {
  const emoji = SEVERITY_EMOJI[payload.severity] ?? "🔵";
  return `${emoji} [${payload.severity.toUpperCase()}] Incident ${payload.incidentId} - ${payload.service} (${payload.environment})`;
}

export function formatSlackIncidentCreated(
  payload: IncidentCreatedNotificationPayload,
): Record<string, unknown> {
  const signals = payload.triggerSignals.slice(0, MAX_SIGNALS);
  const overflow = payload.triggerSignals.length - signals.length;
  const signalText = signals.map((signal) => `• ${signal}`).join("\n")
    + (overflow > 0 ? `\n_...and ${overflow} more_` : "");

  const blocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${buildIncidentText(payload)}*` },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Service:*\n\`${payload.service}\`` },
          { type: "mrkdwn", text: `*Environment:*\n\`${payload.environment}\`` },
        ],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Trigger Signals:*\n${signalText}` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Diagnosis:*\n_Diagnosing now. Follow-up will be posted in this thread._" },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View in Console" },
            url: payload.consoleUrl,
            style: "primary",
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `3am · <!date^${Math.floor(new Date(payload.openedAt).getTime() / 1000)}^{date_short_pretty} at {time}|${payload.openedAt}>`,
          },
        ],
      },
    ];

  return {
    text: `${buildIncidentText(payload)}. Diagnosing now.`,
    blocks,
  };
}

export const formatSlack = formatSlackIncidentCreated;

export function formatSlackDiagnosisComplete(
  payload: DiagnosisNotificationPayload,
): Record<string, unknown> {
  const chain = payload.causalChain.slice(0, MAX_CHAIN)
    .map((step, index) => `${index + 1}. ${step}`)
    .join("\n");

  return {
    text: `Diagnosis complete for ${payload.incidentId}: ${payload.rootCauseHypothesis}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Diagnosis complete* · ${payload.confidence}` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Root cause*\n${payload.rootCauseHypothesis}` },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Immediate action*\n${payload.immediateAction}` },
          { type: "mrkdwn", text: `*Do not*\n${payload.doNot}` },
        ],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Causal chain*\n${chain || "_No causal chain available._"}` },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View in Console" },
            url: payload.consoleUrl,
          },
        ],
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: "3am diagnosis" },
        ],
      },
    ],
  };
}

export async function postSlackMessage(
  target: SlackTargetConfig,
  body: Record<string, unknown>,
  threadTs?: string,
): Promise<SlackPostResult> {
  try {
    const response = await fetch(SLACK_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${target.botToken}`,
      },
      body: JSON.stringify({
        channel: target.channelId,
        ...body,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        unfurl_links: false,
        unfurl_media: false,
      }),
    });

    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok || payload["ok"] !== true) {
      return {
        ok: false,
        error: typeof payload["error"] === "string" ? payload["error"] : `http_${response.status}`,
      };
    }

    return {
      ok: true,
      ts: typeof payload["ts"] === "string" ? payload["ts"] : undefined,
      channel: typeof payload["channel"] === "string" ? payload["channel"] : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
