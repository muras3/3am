import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

export function detectPackageManager(dir: string): PackageManager {
  let currentDir = dir;
  const rootDir = parse(dir).root;

  while (true) {
    if (
      existsSync(join(currentDir, "pnpm-lock.yaml")) ||
      existsSync(join(currentDir, "pnpm-workspace.yaml"))
    ) {
      return "pnpm";
    }
    if (existsSync(join(currentDir, "yarn.lock"))) return "yarn";
    if (existsSync(join(currentDir, "bun.lockb"))) return "bun";

    if (currentDir === rootDir) break;
    currentDir = dirname(currentDir);
  }

  return "npm";
}
