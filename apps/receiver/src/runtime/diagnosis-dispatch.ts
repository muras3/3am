export interface DiagnosisQueueMessage {
  incidentId: string;
  mode?: "diagnosis" | "narrative";
}

export type EnqueueDiagnosisFn = (
  incidentId: string,
  mode?: DiagnosisQueueMessage["mode"],
  delaySeconds?: number,
) => Promise<void>;

export const DEFAULT_DIAGNOSIS_LEASE_MS = 15 * 60_000;
