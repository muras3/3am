import { z } from "zod";

export const ExtractedSpanSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  serviceName: z.string(),
  environment: z.string(),
  httpRoute: z.string().optional(),
  httpStatusCode: z.number().optional(),
  spanStatusCode: z.number(),
  spanKind: z.number().optional(),
  durationMs: z.number(),
  startTimeMs: z.number(),
  exceptionCount: z.number(),
  peerService: z.string().optional(),
  parentSpanId: z.string().optional(),
  spanName: z.string().optional(),
  httpMethod: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type ExtractedSpan = z.infer<typeof ExtractedSpanSchema>;
