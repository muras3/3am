import type { ProviderName } from "3am-diagnosis";
import type { StorageDriver } from "../storage/interface.js";

export type DiagnosisMode = "automatic" | "manual";

export type ReceiverLlmSettings = {
  mode: DiagnosisMode;
  provider?: ProviderName;
  bridgeUrl: string;
};

export const SETTINGS_KEY_DIAGNOSIS_MODE = "diagnosis_mode";
export const SETTINGS_KEY_DIAGNOSIS_PROVIDER = "diagnosis_provider";
export const SETTINGS_KEY_LLM_BRIDGE_URL = "llm_bridge_url";

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:4269";

function isProviderName(value: string | undefined): value is ProviderName {
  return value === "anthropic"
    || value === "openai"
    || value === "ollama"
    || value === "claude-code"
    || value === "codex";
}

/**
 * Providers that require a local subprocess (claude CLI / codex CLI).
 * These cannot run on serverless platforms (Vercel, CF Workers) in automatic mode.
 * In automatic mode, if the stored provider is subprocess-only, we fall back to
 * autodetect (provider: undefined) so the platform can select Anthropic API instead.
 */
const SUBPROCESS_ONLY_PROVIDERS = new Set<ProviderName>(["claude-code", "codex"]);

function envMode(): DiagnosisMode | undefined {
  return process.env["LLM_MODE"] === "manual"
    ? "manual"
    : process.env["LLM_MODE"] === "automatic"
      ? "automatic"
      : undefined;
}

export async function getReceiverLlmSettings(storage: StorageDriver): Promise<ReceiverLlmSettings> {
  const storedMode = await storage.getSettings(SETTINGS_KEY_DIAGNOSIS_MODE);
  const storedProvider = await storage.getSettings(SETTINGS_KEY_DIAGNOSIS_PROVIDER);
  const storedBridgeUrl = await storage.getSettings(SETTINGS_KEY_LLM_BRIDGE_URL);

  const mode = envMode() ?? (storedMode === "manual" ? "manual" : "automatic");
  const envProvider = process.env["LLM_PROVIDER"];
  let storedProviderName: ProviderName | undefined;
  if (isProviderName(storedProvider ?? undefined)) {
    storedProviderName = storedProvider as ProviderName;
  }
  const resolvedProvider = isProviderName(envProvider) ? envProvider : storedProviderName;

  // In automatic mode, subprocess-only providers (claude-code, codex) cannot run on
  // serverless platforms. Fall back to autodetect (undefined) so the platform selects
  // the best available API-based provider (e.g. Anthropic via ANTHROPIC_API_KEY).
  const provider = (mode === "automatic" && resolvedProvider && SUBPROCESS_ONLY_PROVIDERS.has(resolvedProvider))
    ? undefined
    : resolvedProvider;

  return {
    mode,
    provider,
    bridgeUrl: process.env["LLM_BRIDGE_URL"] ?? storedBridgeUrl ?? DEFAULT_BRIDGE_URL,
  };
}
