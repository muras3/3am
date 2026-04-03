import type { NotificationPayload } from "./types.js";

const EMBED_COLOR = 0xe85d3a; // #E85D3A as integer

const MAX_SIGNALS = 5;

// Discord embed field limits (per Discord API spec)
const FIELD_VALUE_MAX = 1024;
const EMBED_TOTAL_MAX = 6000;

export function formatDiscord(payload: NotificationPayload): Record<string, unknown> {
  const severityLabel = payload.severity.toUpperCase();
  const title = `[${severityLabel}] Incident ${payload.incidentId}`;
  const description = `**${payload.service}** · ${payload.environment}`;
  const footer = { text: "3am" };

  const signals = payload.triggerSignals;
  const shown = signals.slice(0, MAX_SIGNALS);
  const overflow = signals.length - shown.length;

  const fields: Array<Record<string, unknown>> = shown.map((signal, idx) => ({
    name: `Signal ${idx + 1}`,
    value: signal.slice(0, FIELD_VALUE_MAX),
    inline: true,
  }));

  if (overflow > 0) {
    fields.push({
      name: "More",
      value: `...and ${overflow} more`,
      inline: false,
    });
  }

  // Guard: ensure total embed content stays under 6000 chars
  const totalContentLength =
    title.length +
    description.length +
    footer.text.length +
    fields.reduce((sum, f) => sum + String(f["name"]).length + String(f["value"]).length, 0);

  if (totalContentLength > EMBED_TOTAL_MAX) {
    // Truncate field values proportionally by trimming the last field until within limit
    let excess = totalContentLength - EMBED_TOTAL_MAX;
    for (let i = fields.length - 1; i >= 0 && excess > 0; i--) {
      const fieldValue = String(fields[i]!["value"]);
      const trim = Math.min(excess, fieldValue.length);
      fields[i]!["value"] = fieldValue.slice(0, fieldValue.length - trim);
      excess -= trim;
    }
  }

  const embed: Record<string, unknown> = {
    color: EMBED_COLOR,
    title,
    description,
    url: payload.consoleUrl,
    fields,
    footer,
    timestamp: payload.openedAt,
  };

  return {
    content: title,
    embeds: [embed],
  };
}
