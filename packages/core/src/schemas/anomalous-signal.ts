import { z } from "zod";

export const AnomalousSignalSchema = z.object({
  signal: z.string(),
  firstSeenAt: z.string(),
  entity: z.string(),
  spanId: z.string(),
}).strict();

export type AnomalousSignal = z.infer<typeof AnomalousSignalSchema>;
