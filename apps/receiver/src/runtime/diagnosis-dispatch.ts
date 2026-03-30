export interface DiagnosisQueueMessage {
  incidentId: string;
}

export type EnqueueDiagnosisFn = (incidentId: string) => Promise<void>;

export const DEFAULT_DIAGNOSIS_LEASE_MS = 15 * 60_000;
