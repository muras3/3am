import { DiagnosisResultSchema, type DiagnosisResult } from "@3amoncall/core";

export type ResultMeta = {
  incidentId: string;
  packetId: string;
  model: string;
  promptVersion: string;
};

export function parseResult(raw: string, meta: ResultMeta): DiagnosisResult {
  let parsed: unknown;

  // First attempt: direct JSON parse
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Second attempt: extract from code fence
    const match = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(raw);
    if (match?.[1] !== undefined) {
      try {
        parsed = JSON.parse(match[1]);
      } catch {
        throw new Error("Failed to parse model output as JSON");
      }
    } else {
      throw new Error("Failed to parse model output as JSON");
    }
  }

  const withMeta = {
    ...(parsed as Record<string, unknown>),
    metadata: {
      incident_id: meta.incidentId,
      packet_id: meta.packetId,
      model: meta.model,
      prompt_version: meta.promptVersion,
      created_at: new Date().toISOString(),
    },
  };

  // Throws ZodError if schema is not satisfied
  return DiagnosisResultSchema.parse(withMeta);
}
