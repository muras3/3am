export interface NotificationPayload {
  incidentId: string;
  title: string;
  severity: string;
  service: string;
  environment: string;
  triggerSignals: string[];
  openedAt: string;
  consoleUrl: string;
}
