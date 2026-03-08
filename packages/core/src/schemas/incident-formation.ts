import { z } from "zod";

export const IncidentStatusSchema = z.enum(["open", "closed"]);

export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

export const IncidentFormationKeySchema = z.object({
  environment: z.string(),
  timeWindow: z.object({
    start: z.string(),
    end: z.string(),
  }),
  primaryService: z.string(),
  dependency: z.string().optional(),
});

export type IncidentFormationKey = z.infer<typeof IncidentFormationKeySchema>;

export const IncidentFormationContextSchema = z.object({
  deploymentId: z.string().optional(),
  releaseVersion: z.string().optional(),
  configChange: z.string().optional(),
  route: z.string().optional(),
  platformEvent: z.string().optional(),
});

export type IncidentFormationContext = z.infer<typeof IncidentFormationContextSchema>;
