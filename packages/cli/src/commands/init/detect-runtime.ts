import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type RuntimeTarget = "node-like" | "cloudflare-workers";

/** Workspace marker files that indicate a monorepo root. */
const WORKSPACE_MARKERS = [
  "pnpm-workspace.yaml",
  "pnpm-workspace.yml",
  "turbo.json",
  "lerna.json",
  "nx.json",
];

/** Subdirectory names to scan for workers when at a monorepo root. */
const WORKSPACE_APP_DIRS = ["apps", "packages", "services", "workers"];

export function findWranglerConfigPath(cwd: string): string | null {
  const jsoncPath = join(cwd, "wrangler.jsonc");
  if (existsSync(jsoncPath)) return jsoncPath;

  const tomlPath = join(cwd, "wrangler.toml");
  if (existsSync(tomlPath)) return tomlPath;

  return null;
}

/**
 * Return true if package.json at cwd has a non-empty `workspaces` field.
 * Accepts:
 *   - Array form (npm/yarn Berry): `["apps/*"]` → true only if non-empty
 *   - Object form (yarn classic):  `{packages: ["apps/*"]}` → true only if non-empty packages array
 * Returns false for empty arrays, empty objects, absent field, or parse errors.
 */
function hasPackageJsonWorkspaces(cwd: string): boolean {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    const ws = pkg["workspaces"];
    if (Array.isArray(ws)) return ws.length > 0;
    if (ws !== null && typeof ws === "object") {
      const pkgs = (ws as Record<string, unknown>)["packages"];
      return Array.isArray(pkgs) && pkgs.length > 0;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Detect whether the cwd is a monorepo workspace root.
 * Returns true if any workspace marker file exists at cwd,
 * OR if package.json declares a `workspaces` field (npm/yarn pattern).
 */
export function isMonorepoRoot(cwd: string): boolean {
  return (
    WORKSPACE_MARKERS.some((marker) => existsSync(join(cwd, marker))) ||
    hasPackageJsonWorkspaces(cwd)
  );
}

/**
 * Find Cloudflare Worker wrangler config paths within a monorepo workspace.
 * Scans apps, packages, services, workers subdirectories for wrangler.jsonc / wrangler.toml.
 * Returns all found paths, sorted for deterministic output.
 */
export function findWorkspaceWranglerConfigs(cwd: string): string[] {
  const found: string[] = [];

  for (const appDir of WORKSPACE_APP_DIRS) {
    const appsPath = join(cwd, appDir);
    if (!existsSync(appsPath)) continue;

    let entries: string[];
    try {
      entries = readdirSync(appsPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(appsPath, entry);
      const jsoncPath = join(entryPath, "wrangler.jsonc");
      if (existsSync(jsoncPath)) {
        found.push(jsoncPath);
        continue;
      }
      const tomlPath = join(entryPath, "wrangler.toml");
      if (existsSync(tomlPath)) {
        found.push(tomlPath);
      }
    }
  }

  return found.sort();
}

export function detectRuntimeTarget(cwd: string): RuntimeTarget {
  return findWranglerConfigPath(cwd) ? "cloudflare-workers" : "node-like";
}
