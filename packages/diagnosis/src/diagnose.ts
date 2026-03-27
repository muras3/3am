import type { IncidentPacket, DiagnosisResult } from "@3amoncall/core";
import { buildPrompt } from "./prompt.js";
import { callModel } from "./model-client.js";
import { parseResult } from "./parse-result.js";

export type DiagnoseOptions = {
  model?: string;
  promptVersion?: string;
  locale?: "en" | "ja";
};

export async function diagnose(
  packet: IncidentPacket,
  options?: DiagnoseOptions,
): Promise<DiagnosisResult> {
  const model = options?.model ?? "claude-sonnet-4-6";
  const promptVersion = options?.promptVersion ?? "v5";
  const prompt = buildPrompt(packet, { locale: options?.locale });
  const raw = await callModel(prompt, { model, maxTokens: 8192 });
  return parseResult(raw, {
    incidentId: packet.incidentId,
    packetId: packet.packetId,
    model,
    promptVersion,
  });
}
