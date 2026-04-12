#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runDiagnose } from "./commands/diagnose.js";

export { runDiagnose };

export async function run(argv: string[]): Promise<void> {
  return runDiagnose(argv);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  run(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`Unexpected error: ${String(err)}\n`);
    process.exit(1);
  });
}
