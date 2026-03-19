import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { detectFramework } from "./init/detect-framework.js";
import { detectPackageManager } from "./init/detect-package-manager.js";
import { getInstrumentationTemplate } from "./init/templates.js";

const OTEL_DEPS = [
  "@opentelemetry/sdk-node",
  "@opentelemetry/auto-instrumentations-node",
  "@opentelemetry/exporter-trace-otlp-http",
  "@opentelemetry/exporter-metrics-otlp-http",
  "@opentelemetry/exporter-logs-otlp-http",
  "@opentelemetry/sdk-logs",
  "@opentelemetry/sdk-metrics",
];

function getInstallCommand(pm: string, deps: string[]): string {
  const depsStr = deps.join(" ");
  switch (pm) {
    case "pnpm": return `pnpm add ${depsStr}`;
    case "yarn": return `yarn add ${depsStr}`;
    case "bun": return `bun add ${depsStr}`;
    default: return `npm install ${depsStr}`;
  }
}

/**
 * Returns true if the project is TypeScript (has typescript dep or tsconfig.json).
 */
export function isTypeScriptProject(
  cwd: string,
  allDeps: Record<string, string>,
): boolean {
  if ("typescript" in allDeps) return true;
  if (existsSync(join(cwd, "tsconfig.json"))) return true;
  return false;
}

/**
 * Returns true if the project is ESM (package.json has "type": "module").
 */
export function isEsmProject(pkg: { type?: string }): boolean {
  return pkg.type === "module";
}

export function updateEnvFile(
  content: string,
  updates: Record<string, string>,
): string {
  let result = content;
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    const line = `${key}=${value}`;
    if (regex.test(result)) {
      result = result.replace(regex, line);
    } else {
      result = result.endsWith("\n") ? result + line + "\n" : result + "\n" + line + "\n";
    }
  }
  return result;
}

export async function runInit(_argv: string[]): Promise<void> {
  const cwd = process.cwd();
  const pkgPath = join(cwd, "package.json");

  if (!existsSync(pkgPath)) {
    process.stderr.write("Error: no package.json found in current directory\n");
    process.exit(1);
    return;
  }

  let pkg: { name?: string; type?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as typeof pkg;
  } catch {
    process.stderr.write("Error: could not parse package.json\n");
    process.exit(1);
    return;
  }

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const framework = detectFramework(allDeps);
  const pm = detectPackageManager(cwd);
  const serviceName = pkg.name ?? "my-service";
  const isTs = isTypeScriptProject(cwd, allDeps);
  const isEsm = isEsmProject(pkg);

  // --- Install deps first (Finding 6: avoid partial state on failure) ---
  const pkgBackupPath = pkgPath + ".bak";
  copyFileSync(pkgPath, pkgBackupPath);

  const installCmd = getInstallCommand(pm, OTEL_DEPS);
  process.stdout.write(`Installing OTel dependencies: ${installCmd}\n`);

  try {
    execSync(installCmd, { cwd, stdio: "inherit" });
  } catch (err) {
    process.stderr.write(`Error: dependency install failed: ${String(err)}\n`);
    copyFileSync(pkgBackupPath, pkgPath);
    process.stderr.write("package.json restored.\n");
    process.stderr.write(`Run manually: ${installCmd}\n`);
    process.exit(1);
    return;
  }

  try {
    unlinkSync(pkgBackupPath);
  } catch {
    // backup cleanup failure is non-fatal
  }

  // --- Generate instrumentation file (Finding 3: match extension to language) ---
  const instrumentationExt = isTs ? ".ts" : ".js";
  const instrumentationFile = `instrumentation${instrumentationExt}`;
  const instrumentationPath = join(cwd, instrumentationFile);

  if (existsSync(instrumentationPath)) {
    process.stdout.write(`${instrumentationFile} already exists — skipping.\n`);
  } else {
    const template = getInstrumentationTemplate(framework);
    writeFileSync(instrumentationPath, template, "utf-8");
    process.stdout.write(`Created ${instrumentationFile}\n`);
  }

  // --- Update .env ---
  const envPath = join(cwd, ".env");
  const envContent = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const updatedEnv = updateEnvFile(envContent, {
    OTEL_SERVICE_NAME: serviceName,
    OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=development",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:3333",
    OTEL_EXPORTER_OTLP_HEADERS: "",
  });
  writeFileSync(envPath, updatedEnv, "utf-8");
  process.stdout.write("Updated .env\n");

  process.stdout.write("\n3amoncall init complete!\n\n");

  // --- Startup guidance (Finding 3: match flag to module system) ---
  if (framework === "nextjs") {
    process.stdout.write(
      "Next.js detected: instrumentation.ts uses register() export — Next.js loads it automatically.\n",
    );
  } else if (isEsm) {
    process.stdout.write(
      `Add --import to your startup command:\n` +
      `  node --import ./${instrumentationFile} app.js\n`,
    );
  } else {
    process.stdout.write(
      `Add --require to your startup command:\n` +
      `  node --require ./${instrumentationFile} app.js\n`,
    );
  }

  process.stdout.write(
    "\nNext: run `npx 3amoncall dev` to start the local Receiver, then start your app.\n",
  );
}

export async function runUpgrade(_argv: string[]): Promise<void> {
  const cwd = process.cwd();
  const envPath = join(cwd, ".env");

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  process.stdout.write("3amoncall init --upgrade\n");
  process.stdout.write("Switches your OTel config from local dev to production Receiver.\n\n");

  const receiverUrl = await question("Receiver URL (e.g. https://your-app.vercel.app): ");
  const authToken = await question("AUTH_TOKEN (from Console setup screen): ");

  rl.close();

  const envContent = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";

  let updated = updateEnvFile(envContent, {
    OTEL_EXPORTER_OTLP_ENDPOINT: receiverUrl.trim(),
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${authToken.trim()}`,
  });

  updated = updated.replace(
    /^(OTEL_RESOURCE_ATTRIBUTES=.*deployment\.environment\.name=)development(.*)$/m,
    "$1production$2",
  );

  writeFileSync(envPath, updated, "utf-8");
  process.stdout.write("\n.env updated for production.\n");
  process.stdout.write("Restart your app to apply the new OTel configuration.\n");
}
