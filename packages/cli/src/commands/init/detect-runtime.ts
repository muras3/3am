import { existsSync } from "node:fs";
import { join } from "node:path";

export type RuntimeTarget = "node-like" | "cloudflare-workers";

export function findWranglerConfigPath(cwd: string): string | null {
  const jsoncPath = join(cwd, "wrangler.jsonc");
  if (existsSync(jsoncPath)) return jsoncPath;

  const tomlPath = join(cwd, "wrangler.toml");
  if (existsSync(tomlPath)) return tomlPath;

  return null;
}

export function detectRuntimeTarget(cwd: string): RuntimeTarget {
  return findWranglerConfigPath(cwd) ? "cloudflare-workers" : "node-like";
}
