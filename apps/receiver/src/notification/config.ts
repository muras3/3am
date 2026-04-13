import type { StorageDriver } from "../storage/interface.js";
import { parseNotificationConfig, type NotificationConfig } from "./types.js";

export const SETTINGS_KEY_NOTIFICATION_CONFIG = "notification_config";

export async function getNotificationConfig(storage: StorageDriver): Promise<NotificationConfig> {
  const raw = await storage.getSettings(SETTINGS_KEY_NOTIFICATION_CONFIG);
  if (!raw) return { targets: [] };

  try {
    return parseNotificationConfig(JSON.parse(raw));
  } catch {
    console.warn("[notification] invalid stored notification_config; ignoring");
    return { targets: [] };
  }
}

export async function setNotificationConfig(
  storage: StorageDriver,
  config: NotificationConfig,
): Promise<void> {
  await storage.setSettings(SETTINGS_KEY_NOTIFICATION_CONFIG, JSON.stringify(config));
}
