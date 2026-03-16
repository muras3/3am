import { z } from "zod";
import { ExtractedSpanSchema } from "./extracted-span.js";
import { AnomalousSignalSchema } from "./anomalous-signal.js";
import { ChangedMetricSchema, RelevantLogSchema, PlatformEventSchema } from "./incident-packet.js";

export const IncidentRawStateSchema = z.object({
  spans: z.array(ExtractedSpanSchema),
  anomalousSignals: z.array(AnomalousSignalSchema),
  metricEvidence: z.array(ChangedMetricSchema),
  logEvidence: z.array(RelevantLogSchema),
  platformEvents: z.array(PlatformEventSchema),
}).strict();

export type IncidentRawState = z.infer<typeof IncidentRawStateSchema>;
