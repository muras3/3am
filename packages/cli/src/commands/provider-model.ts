import type { ProviderName } from "3am-diagnosis";

export function resolveProviderModel(
  provider: ProviderName | undefined,
  explicitModel?: string,
  storedModel?: string,
): string | undefined {
  if (explicitModel) return explicitModel;
  return storedModel;
}
