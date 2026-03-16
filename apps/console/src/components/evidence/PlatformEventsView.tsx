import type { PlatformEvent } from "../../api/types.js";

interface Props {
  rawEvents: PlatformEvent[];
  packetEvents: PlatformEvent[];
  onEventSelect: (event: PlatformEvent) => void;
}

type EventType = PlatformEvent["eventType"];

function badgeClass(eventType: EventType): string {
  if (eventType === "deploy") return "pe-deploy";
  if (eventType === "config_change") return "pe-config";
  if (eventType === "provider_incident") return "pe-provider";
  if (eventType === "scaling_event") return "pe-scaling";
  return "pe-scaling";
}

function badgeLabel(eventType: EventType): string {
  if (eventType === "deploy") return "deploy";
  if (eventType === "config_change") return "config";
  if (eventType === "provider_incident") return "provider";
  if (eventType === "scaling_event") return "scaling";
  return eventType;
}

function stripColor(eventType: EventType): string {
  if (eventType === "deploy") return "var(--good)";
  if (eventType === "config_change") return "var(--teal)";
  if (eventType === "provider_incident") return "var(--amber)";
  if (eventType === "scaling_event") return "var(--ink-3)";
  return "var(--ink-3)";
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toISOString().slice(11, 19);
  } catch {
    return ts.slice(0, 8);
  }
}

function isHighlighted(event: PlatformEvent, packetEvents: PlatformEvent[]): boolean {
  return packetEvents.some((pe) => {
    // eventId is the most reliable match key
    if (event.eventId && pe.eventId) {
      return event.eventId === pe.eventId;
    }
    // Fallback: timestamp + eventType collision avoidance
    return event.timestamp === pe.timestamp && event.eventType === pe.eventType;
  });
}

export function PlatformEventsView({ rawEvents, packetEvents, onEventSelect }: Props) {
  if (rawEvents.length === 0) {
    return (
      <div className="pe-list" data-testid="platform-events-view">
        <div style={{ color: "var(--ink-3)", fontSize: "var(--fs-sm)", padding: "16px 0" }}>
          No platform events captured for this incident.
        </div>
      </div>
    );
  }

  // Sort by timestamp ascending
  const sorted = [...rawEvents].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );

  return (
    <div className="pe-list" data-testid="platform-events-view">
      {sorted.map((event, i) => {
        const highlighted = isHighlighted(event, packetEvents);
        return (
          <div
            key={event.eventId ?? `${event.timestamp}-${i}`}
            className={`pe-item${highlighted ? " highlighted" : ""}`}
            data-testid="pe-item"
            onClick={() => onEventSelect(event)}
          >
            <div
              className="pe-strip"
              style={{ background: stripColor(event.eventType) }}
            />
            <div className="pe-time">{formatTime(event.timestamp)}</div>
            <div className={`pe-badge ${badgeClass(event.eventType)}`}>
              {badgeLabel(event.eventType)}
            </div>
            <div className="pe-desc">{event.description}</div>
            {event.service && (
              <div className="pe-role">{event.service}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
