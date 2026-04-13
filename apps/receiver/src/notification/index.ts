import type { DiagnosisResult, IncidentPacket } from "3am-core";
import type { StorageDriver } from "../storage/interface.js";
import { getNotificationConfig } from "./config.js";
import {
  formatDiscordDiagnosisComplete,
  formatDiscordIncidentCreated,
  postDiscordMessage,
  sendDiscordConnectivityProbe,
} from "./discord.js";
import { formatSlackDiagnosisComplete, formatSlackIncidentCreated, postSlackMessage } from "./slack.js";
import {
  buildDiagnosisNotificationPayload,
  buildIncidentCreatedPayload,
  createEmptyIncidentNotificationState,
  type IncidentNotificationState,
  type NotificationDeliveryRef,
} from "./types.js";

function buildConsoleUrl(incidentId: string): string {
  const base = process.env["CONSOLE_BASE_URL"] || "http://localhost:3333";
  return `${base}/incidents/${incidentId}`;
}

async function storeDeliveryState(
  storage: StorageDriver,
  incidentId: string,
  nextDelivery: NotificationDeliveryRef,
): Promise<void> {
  const incident = await storage.getIncident(incidentId);
  if (!incident) return;
  const current = incident.notificationState ?? createEmptyIncidentNotificationState();
  const deliveries = current.deliveries.filter((delivery) => delivery.targetId !== nextDelivery.targetId);
  deliveries.push(nextDelivery);
  await storage.updateNotificationState(incidentId, { deliveries });
}

function markDeliveryDiagnosed(
  state: IncidentNotificationState,
  targetId: string,
): IncidentNotificationState {
  return {
    deliveries: state.deliveries.map((delivery) =>
      delivery.targetId === targetId
        ? { ...delivery, diagnosisNotifiedAt: new Date().toISOString() }
        : delivery),
  };
}

export async function notifyIncidentCreated(
  storage: StorageDriver,
  packet: IncidentPacket,
  incidentId: string,
): Promise<void> {
  try {
    const config = await getNotificationConfig(storage);
    if (config.targets.length === 0) return;

    const consoleUrl = buildConsoleUrl(incidentId);
    const payload = buildIncidentCreatedPayload(packet, incidentId, consoleUrl);

    for (const target of config.targets.filter((candidate) => candidate.enabled)) {
      if (target.provider === "slack") {
        const result = await postSlackMessage(target, formatSlackIncidentCreated(payload));
        if (result.ok && result.ts) {
          await storeDeliveryState(storage, incidentId, {
            provider: "slack",
            targetId: target.id,
            parentTs: result.ts,
            channelId: result.channel ?? target.channelId,
            parentNotifiedAt: new Date().toISOString(),
          });
        }
        continue;
      }

      const result = await postDiscordMessage(target, formatDiscordIncidentCreated(payload));
      if (result.ok && result.messageId) {
        await storeDeliveryState(storage, incidentId, {
          provider: "discord",
          targetId: target.id,
          messageId: result.messageId,
          ...(result.threadId ? { threadId: result.threadId } : {}),
          parentNotifiedAt: new Date().toISOString(),
        });
      }
    }
  } catch (error) {
    console.warn("[notification] incident-created failed:", error instanceof Error ? error.message : error);
  }
}

export async function notifyDiagnosisComplete(
  storage: StorageDriver,
  packet: IncidentPacket,
  incidentId: string,
  result: DiagnosisResult,
): Promise<void> {
  try {
    const incident = await storage.getIncident(incidentId);
    if (!incident) return;
    const notificationState = incident.notificationState;
    if (!notificationState || notificationState.deliveries.length === 0) return;

    const config = await getNotificationConfig(storage);
    const consoleUrl = buildConsoleUrl(incidentId);
    const payload = buildDiagnosisNotificationPayload(packet, incidentId, result, consoleUrl);

    let nextState = notificationState;
    for (const delivery of notificationState.deliveries) {
      if (delivery.diagnosisNotifiedAt) continue;
      const target = config.targets.find((candidate) => candidate.id === delivery.targetId && candidate.enabled);
      if (!target) continue;

      if (delivery.provider === "slack" && target.provider === "slack") {
        const posted = await postSlackMessage(
          target,
          formatSlackDiagnosisComplete(payload),
          delivery.parentTs,
        );
        if (posted.ok) {
          nextState = markDeliveryDiagnosed(nextState, delivery.targetId);
        }
        continue;
      }

      if (delivery.provider === "discord" && target.provider === "discord") {
        const posted = await postDiscordMessage(
          target,
          formatDiscordDiagnosisComplete(payload),
          {
            messageId: delivery.messageId,
            threadId: delivery.threadId,
            incidentId,
          },
        );
        if (posted.ok) {
          nextState = {
            deliveries: nextState.deliveries.map((entry) =>
              entry.targetId === delivery.targetId
                ? {
                    ...entry,
                    ...(posted.threadId ? { threadId: posted.threadId } : {}),
                    diagnosisNotifiedAt: new Date().toISOString(),
                  }
                : entry),
          };
        }
      }
    }

    if (nextState !== notificationState) {
      await storage.updateNotificationState(incidentId, nextState);
    }
  } catch (error) {
    console.warn("[notification] diagnosis-complete failed:", error instanceof Error ? error.message : error);
  }
}

export async function sendNotificationTest(storage: StorageDriver): Promise<{
  ok: boolean;
  sent: Array<{ targetId: string; provider: "slack" | "discord" }>;
  error?: string;
}> {
  try {
    const config = await getNotificationConfig(storage);
    const sent: Array<{ targetId: string; provider: "slack" | "discord" }> = [];
    const payload = {
      incidentId: "test_notification",
      severity: "medium",
      service: "3am",
      environment: "test",
      triggerSignals: ["Notification integration verified"],
      openedAt: new Date().toISOString(),
      consoleUrl: process.env["CONSOLE_BASE_URL"] || "http://localhost:3333",
    };

    for (const target of config.targets.filter((candidate) => candidate.enabled)) {
      if (target.provider === "slack") {
        const result = await postSlackMessage(target, formatSlackIncidentCreated(payload));
        if (result.ok) sent.push({ targetId: target.id, provider: "slack" });
        continue;
      }
      const result = await sendDiscordConnectivityProbe(target);
      if (result.ok) sent.push({ targetId: target.id, provider: "discord" });
    }

    return sent.length > 0 ? { ok: true, sent } : { ok: false, sent, error: "no notification target accepted the test message" };
  } catch (error) {
    return {
      ok: false,
      sent: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
