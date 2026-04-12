import { z } from "zod";

export const AnomalousSignalSchema = z.strictObject({
  signal: z.string(),
  firstSeenAt: z.string(),
  entity: z.string(),
  spanId: z.string(),
});

export type AnomalousSignal = z.infer<typeof AnomalousSignalSchema>;
