import type { DiagnosisResult, IncidentPacket } from "3am-core";
import { z } from "zod";

export type NotificationProvider = "slack" | "discord";

const SlackTargetConfigSchema = z.strictObject({
  id: z.string(),
  provider: z.literal("slack"),
  label: z.string(),
  enabled: z.boolean().default(true),
  botToken: z.string(),
  channelId: z.string(),
});

const DiscordTargetConfigSchema = z.strictObject({
  id: z.string(),
  provider: z.literal("discord"),
  label: z.string(),
  enabled: z.boolean().default(true),
  webhookUrl: z.string().url(),
});

export const NotificationTargetConfigSchema = z.discriminatedUnion("provider", [
  SlackTargetConfigSchema,
  DiscordTargetConfigSchema,
]);

export type NotificationTargetConfig = z.infer<typeof NotificationTargetConfigSchema>;
export type SlackTargetConfig = z.infer<typeof SlackTargetConfigSchema>;
export type DiscordTargetConfig = z.infer<typeof DiscordTargetConfigSchema>;

export const NotificationConfigSchema = z.strictObject({
  targets: z.array(NotificationTargetConfigSchema).default([]),
});

export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;

const SlackDeliveryRefSchema = z.strictObject({
  provider: z.literal("slack"),
  targetId: z.string(),
  parentTs: z.string(),
  channelId: z.string(),
  parentNotifiedAt: z.string(),
  diagnosisNotifiedAt: z.string().optional(),
});

const DiscordDeliveryRefSchema = z.strictObject({
  provider: z.literal("discord"),
  targetId: z.string(),
  messageId: z.string(),
  parentNotifiedAt: z.string(),
  diagnosisNotifiedAt: z.string().optional(),
});

export const NotificationDeliveryRefSchema = z.discriminatedUnion("provider", [
  SlackDeliveryRefSchema,
  DiscordDeliveryRefSchema,
]);

export type NotificationDeliveryRef = z.infer<typeof NotificationDeliveryRefSchema>;

export const IncidentNotificationStateSchema = z.strictObject({
  deliveries: z.array(NotificationDeliveryRefSchema).default([]),
});

export type IncidentNotificationState = z.infer<typeof IncidentNotificationStateSchema>;

export interface IncidentCreatedNotificationPayload {
  incidentId: string;
  severity: string;
  service: string;
  environment: string;
  triggerSignals: string[];
  openedAt: string;
  consoleUrl: string;
}

export type NotificationPayload = IncidentCreatedNotificationPayload & { title?: string };

export interface DiagnosisNotificationPayload {
  incidentId: string;
  severity: string;
  service: string;
  environment: string;
  consoleUrl: string;
  rootCauseHypothesis: string;
  immediateAction: string;
  doNot: string;
  confidence: string;
  causalChain: string[];
}

export function parseNotificationConfig(value: unknown): NotificationConfig {
  return NotificationConfigSchema.parse(value);
}

export function parseIncidentNotificationState(value: unknown): IncidentNotificationState {
  return IncidentNotificationStateSchema.parse(value);
}

export function createEmptyIncidentNotificationState(): IncidentNotificationState {
  return { deliveries: [] };
}

export function buildIncidentCreatedPayload(
  packet: IncidentPacket,
  incidentId: string,
  consoleUrl: string,
): IncidentCreatedNotificationPayload {
  return {
    incidentId,
    severity: packet.signalSeverity ?? "medium",
    service: packet.scope.primaryService,
    environment: packet.scope.environment,
    triggerSignals: packet.triggerSignals.map((signal) => signal.signal),
    openedAt: packet.openedAt,
    consoleUrl,
  };
}

export function buildDiagnosisNotificationPayload(
  packet: IncidentPacket,
  incidentId: string,
  result: DiagnosisResult,
  consoleUrl: string,
): DiagnosisNotificationPayload {
  return {
    incidentId,
    severity: packet.signalSeverity ?? "medium",
    service: packet.scope.primaryService,
    environment: packet.scope.environment,
    consoleUrl,
    rootCauseHypothesis: result.summary.root_cause_hypothesis,
    immediateAction: result.recommendation.immediate_action,
    doNot: result.recommendation.do_not,
    confidence: result.confidence.confidence_assessment,
    causalChain: result.reasoning.causal_chain.map((step) => step.title),
  };
}
