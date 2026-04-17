/**
 * Auto-patch package.json scripts to load instrumentation at startup.
 *
 * - `node ...`     → `node --import ./instrumentation.{ext} ...` (ESM) or `--require` (CJS)
 * - `ts-node ...`  → `node --import ./instrumentation.{ext} ...` (ts-node has OTel compat issues)
 * - `nodemon ...`  → `nodemon --import ./instrumentation.{ext} ...` (ESM) or `--require` (CJS)
 * - Next.js        → skip (uses register() export)
 * - Already has --import/--require instrumentation → skip
 */

const SCRIPT_TARGETS = ["start", "dev", "serve"] as const;

/** Commands we know how to patch */
const NODE_CMD = /^node\s/;
const TS_NODE_CMD = /^ts-node\s/;
const NODEMON_CMD = /^nodemon\s/;
const NEXT_CMD = /^next\s/;

function alreadyPatched(script: string, instrumentationFile: string): boolean {
  return (
    script.includes(`--import ./${instrumentationFile}`) ||
    script.includes(`--require ./${instrumentationFile}`)
  );
}

function patchNodeCommand(
  script: string,
  flag: string,
  instrumentationFile: string,
): string {
  // `node app.js` → `node --import ./instrumentation.ts app.js`
  return script.replace(/^node\s/, `node ${flag} ./${instrumentationFile} `);
}

function patchTsNodeCommand(
  script: string,
  flag: string,
  instrumentationFile: string,
): string {
  // Replace ts-node entirely with node --import (ts-node + OTel = trouble)
  return script.replace(/^ts-node\s/, `node ${flag} ./${instrumentationFile} `);
}

function patchNodemonCommand(
  script: string,
  flag: string,
  instrumentationFile: string,
): string {
  return script.replace(/^nodemon\s/, `nodemon ${flag} ./${instrumentationFile} `);
}

export interface PatchResult {
  /** Script name → new value for scripts that were patched */
  patched: Record<string, string>;
  /** Script names that were skipped (with reason) */
  skipped: Array<{ name: string; reason: string }>;
}

export function patchScripts(
  scripts: Record<string, string> | undefined,
  instrumentationFile: string,
  isNextjs: boolean,
  isEsm: boolean,
): PatchResult {
  const result: PatchResult = { patched: {}, skipped: [] };

  if (!scripts) return result;

  const flag = isEsm ? "--import" : "--require";

  for (const target of SCRIPT_TARGETS) {
    const script = scripts[target];
    if (!script) continue;

    // Next.js commands — register() handles it
    if (isNextjs && NEXT_CMD.test(script)) {
      result.skipped.push({ name: target, reason: "Next.js uses register() export" });
      continue;
    }

    // Already patched
    if (alreadyPatched(script, instrumentationFile)) {
      result.skipped.push({ name: target, reason: "already includes instrumentation" });
      continue;
    }

    if (NODE_CMD.test(script)) {
      result.patched[target] = patchNodeCommand(script, flag, instrumentationFile);
    } else if (TS_NODE_CMD.test(script)) {
      result.patched[target] = patchTsNodeCommand(script, flag, instrumentationFile);
    } else if (NODEMON_CMD.test(script)) {
      result.patched[target] = patchNodemonCommand(script, flag, instrumentationFile);
    } else {
      result.skipped.push({ name: target, reason: `unrecognized command: ${script.split(" ")[0]}` });
    }
  }

  return result;
}
