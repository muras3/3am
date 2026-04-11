export { diagnose } from "./diagnose.js";
export type { DiagnoseOptions } from "./diagnose.js";
export { buildPrompt } from "./prompt.js";
export type { BuildPromptOptions } from "./prompt.js";
export { parseResult } from "./parse-result.js";
export type { ResultMeta } from "./parse-result.js";
export { generateConsoleNarrative } from "./generate-narrative.js";
export type { GenerateNarrativeOptions } from "./generate-narrative.js";
export { buildNarrativePrompt } from "./narrative-prompt.js";
export type { BuildNarrativePromptOptions } from "./narrative-prompt.js";
export { parseNarrative } from "./parse-narrative.js";
export type { NarrativeMeta } from "./parse-narrative.js";
export { generateEvidenceQuery } from "./generate-evidence-query.js";
export type { GenerateEvidenceQueryOptions } from "./generate-evidence-query.js";
export { generateEvidencePlan } from "./generate-evidence-plan.js";
export type { GenerateEvidencePlanOptions } from "./generate-evidence-plan.js";
export { buildEvidenceQueryPrompt } from "./evidence-query-prompt.js";
export type {
  EvidenceQueryPromptEvidence,
  EvidenceQueryPromptInput,
} from "./evidence-query-prompt.js";
export { buildEvidencePlanPrompt } from "./evidence-plan-prompt.js";
export type {
  EvidencePlanPromptEvidence,
  EvidencePlanPromptInput,
} from "./evidence-plan-prompt.js";
export { parseEvidenceQuery } from "./parse-evidence-query.js";
export type { EvidenceQueryParseMeta } from "./parse-evidence-query.js";
export { parseEvidencePlan } from "./parse-evidence-plan.js";
export type { EvidencePlan, EvidencePlanMode } from "./parse-evidence-plan.js";
export {
  PROVIDER_NAMES,
  resolveProvider,
  ProviderResolutionError,
} from "./provider.js";
export type {
  LLMProvider,
  ModelCallOptions,
  ModelMessage,
  ProviderName,
  ProviderPolicy,
  ResolvedProvider,
} from "./provider.js";
export { callModelMessages } from "./model-client.js";
export { wrapUserMessage } from "./user-message-envelope.js";
// claude-code-pool uses node:child_process and must NOT be statically
// imported — it would crash CF Workers. Use dynamic import instead:
//   const { warmUp, shutdown } = await import("@3am/diagnosis/claude-code-pool");
