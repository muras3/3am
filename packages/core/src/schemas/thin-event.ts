import { z } from "zod";

export const ThinEventSchema = z.object({
  event_id: z.string(),
  event_type: z.literal("incident.created"),
  incident_id: z.string(),
  packet_id: z.string(),
});

export type ThinEvent = z.infer<typeof ThinEventSchema>;
