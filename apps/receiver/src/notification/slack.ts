import type { NotificationPayload } from "./types.js";

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
};

const MAX_SIGNALS = 5;

export function formatSlack(payload: NotificationPayload): Record<string, unknown> {
  const emoji = SEVERITY_EMOJI[payload.severity] ?? "🔵";
  const severityLabel = payload.severity.toUpperCase();
  const titleText = `${emoji} [${severityLabel}] Incident ${payload.incidentId}`;
  const fallbackText = `${titleText} — ${payload.service} (${payload.environment})`;

  const signals = payload.triggerSignals;
  const shown = signals.slice(0, MAX_SIGNALS);
  const overflow = signals.length - shown.length;
  const signalList =
    shown.map((s) => `• ${s}`).join("\n") +
    (overflow > 0 ? `\n_...and ${overflow} more_` : "");

  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${titleText}*`,
      },
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
      text: {
        type: "mrkdwn",
        text: `*Trigger Signals:*\n${signalList}`,
      },
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
          text: `3amoncall · <!date^${Math.floor(new Date(payload.openedAt).getTime() / 1000)}^{date_short_pretty} at {time}|${payload.openedAt}>`,
        },
      ],
    },
  ];

  return {
    text: fallbackText,
    attachments: [
      {
        color: "#E85D3A",
        blocks,
      },
    ],
  };
}
