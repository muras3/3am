# Deploy Button + npx 3amoncall init Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce 3amoncall self-host setup from 9 steps to "local 5min trial → 1-click Vercel deploy".

**Architecture:** Receiver gains inline diagnosis (ADR 0034). CLI gains `init` and `dev` subcommands. deploy.json enables Vercel Deploy Button with Neon auto-provision.

**Tech Stack:** Hono (Receiver), commander (CLI), @opentelemetry/sdk-node (init templates), Vercel Deploy Button (deploy.json)

**Design doc:** `docs/plans/2026-03-18-deploy-button-design.md`
**ADR:** `docs/adr/0034-receiver-internal-diagnosis-and-credential-unification.md`

---

## Task 1: deploy.json — Vercel Deploy Button

**Files:**
- Create: `deploy.json`
- Modify: `README.md` (add Deploy Button badge)

**Step 1: Write deploy.json**

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "pnpm turbo run build",
  "installCommand": "pnpm install",
  "framework": null,
  "outputDirectory": "apps/console/dist",
  "env": {
    "ANTHROPIC_API_KEY": {
      "description": "Anthropic API key for LLM diagnosis. Get one at https://console.anthropic.com",
      "required": true
    },
    "RECEIVER_AUTH_TOKEN": {
      "description": "Bearer token for OTel SDK authentication (auto-generated)",
      "generateValue": "secret"
    }
  }
}
```

Note: `integrations` field for Neon auto-provision needs verification against current Vercel Deploy Button spec. Research `https://vercel.com/docs/deploy-button` before finalizing. If `integrations` is not supported in deploy.json, document manual Neon setup in README as fallback.

**Step 2: Add Deploy Button badge to README.md**

Add to top of README.md:

```markdown
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ftmurase-42%2F3amoncall&env=ANTHROPIC_API_KEY&envDescription=Anthropic%20API%20key%20for%20LLM%20diagnosis&project-name=3amoncall&repository-name=3amoncall)
```

**Step 3: Commit**

```bash
git add deploy.json README.md
git commit -m "feat: add Vercel Deploy Button (deploy.json + README badge)"
```

---

## Task 2: Receiver 内診断 — diagnose() を Receiver に配線

**Files:**
- Modify: `apps/receiver/package.json` (add `@3amoncall/diagnosis` dep)
- Create: `apps/receiver/src/runtime/diagnosis-runner.ts`
- Modify: `apps/receiver/src/index.ts` (wire onReady → diagnosis-runner)
- Test: `apps/receiver/src/runtime/__tests__/diagnosis-runner.test.ts`

### Step 1: Add dependency

```bash
cd apps/receiver && pnpm add @3amoncall/diagnosis@workspace:*
```

### Step 2: Write failing test for DiagnosisRunner

File: `apps/receiver/src/runtime/__tests__/diagnosis-runner.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { DiagnosisRunner } from "../diagnosis-runner.js";
import type { StorageDriver } from "../../storage/interface.js";
import type { IncidentPacket, DiagnosisResult } from "@3amoncall/core";

describe("DiagnosisRunner", () => {
  it("fetches packet, runs diagnosis, and stores result", async () => {
    const mockPacket: IncidentPacket = {
      schemaVersion: "incident-packet/v1alpha1",
      packetId: "pkt_1",
      incidentId: "inc_1",
      openedAt: new Date().toISOString(),
      generation: 1,
      window: { startTime: "", endTime: "", durationSec: 60 },
      scope: { environment: "production", primaryService: "web" },
      triggerSignals: [],
      evidence: { spans: [], metrics: [], logs: [], platformEvents: [] },
      pointers: {},
    };

    const mockResult: DiagnosisResult = {
      summary: { what_happened: "test", root_cause_hypothesis: "test" },
      recommendation: {
        immediate_action: "test",
        action_rationale_short: "test",
        do_not: [],
      },
      reasoning: { causal_chain: [] },
      operator_guidance: [],
      confidence: { level: "high", reasoning: "test" },
      metadata: {
        incidentId: "inc_1",
        packetId: "pkt_1",
        model: "claude-sonnet-4-6",
        promptVersion: "v5",
        diagnosedAt: new Date().toISOString(),
      },
    };

    const mockStorage = {
      getIncident: vi.fn().mockResolvedValue({ packet: mockPacket }),
      appendDiagnosis: vi.fn().mockResolvedValue(undefined),
    } as unknown as StorageDriver;

    const mockDiagnose = vi.fn().mockResolvedValue(mockResult);

    const runner = new DiagnosisRunner(mockStorage, mockDiagnose);
    await runner.run("inc_1", "pkt_1");

    expect(mockStorage.getIncident).toHaveBeenCalledWith("inc_1");
    expect(mockDiagnose).toHaveBeenCalledWith(mockPacket);
    expect(mockStorage.appendDiagnosis).toHaveBeenCalledWith("inc_1", mockResult);
  });

  it("logs error but does not throw on diagnosis failure", async () => {
    const mockStorage = {
      getIncident: vi.fn().mockResolvedValue({
        packet: { incidentId: "inc_1" },
      }),
      appendDiagnosis: vi.fn(),
    } as unknown as StorageDriver;

    const mockDiagnose = vi.fn().mockRejectedValue(new Error("LLM timeout"));

    const runner = new DiagnosisRunner(mockStorage, mockDiagnose);
    // Should not throw — diagnosis failure must not crash the Receiver
    await expect(runner.run("inc_1", "pkt_1")).resolves.toBeUndefined();
  });

  it("skips if ANTHROPIC_API_KEY is not set", async () => {
    const mockStorage = {} as StorageDriver;
    const mockDiagnose = vi.fn();

    const runner = new DiagnosisRunner(mockStorage, mockDiagnose, {
      apiKeyAvailable: false,
    });
    await runner.run("inc_1", "pkt_1");

    expect(mockDiagnose).not.toHaveBeenCalled();
  });
});
```

### Step 3: Run test to verify it fails

```bash
cd apps/receiver && pnpm vitest run src/runtime/__tests__/diagnosis-runner.test.ts
```

Expected: FAIL — `DiagnosisRunner` not found.

### Step 4: Implement DiagnosisRunner

File: `apps/receiver/src/runtime/diagnosis-runner.ts`

```typescript
import type { StorageDriver } from "../storage/interface.js";
import type { IncidentPacket, DiagnosisResult } from "@3amoncall/core";

type DiagnoseFn = (packet: IncidentPacket) => Promise<DiagnosisResult>;

interface DiagnosisRunnerOptions {
  apiKeyAvailable?: boolean;
}

export class DiagnosisRunner {
  constructor(
    private readonly storage: StorageDriver,
    private readonly diagnoseFn: DiagnoseFn,
    private readonly options: DiagnosisRunnerOptions = { apiKeyAvailable: true },
  ) {}

  async run(incidentId: string, packetId: string): Promise<void> {
    if (!this.options.apiKeyAvailable) {
      console.warn("[diagnosis] ANTHROPIC_API_KEY not set — skipping diagnosis");
      return;
    }

    try {
      const incident = await this.storage.getIncident(incidentId);
      if (!incident) {
        console.error(`[diagnosis] incident ${incidentId} not found`);
        return;
      }

      const result = await this.diagnoseFn(incident.packet);
      await this.storage.appendDiagnosis(incidentId, result);
      console.log(`[diagnosis] completed for ${incidentId}`);
    } catch (err) {
      console.error(`[diagnosis] failed for ${incidentId}:`, err);
    }
  }
}
```

### Step 5: Run test to verify it passes

```bash
cd apps/receiver && pnpm vitest run src/runtime/__tests__/diagnosis-runner.test.ts
```

Expected: PASS (3 tests)

### Step 6: Wire DiagnosisRunner into createApp()

Modify `apps/receiver/src/index.ts`:
- Import `diagnose` from `@3amoncall/diagnosis`
- Import `DiagnosisRunner`
- Create `DiagnosisRunner` instance
- Replace `onReady` callback to call `runner.run()` instead of `dispatchThinEvent()`
- Keep `saveAndDispatchThinEvent` as fallback when `ANTHROPIC_API_KEY` is not set (backward compat)

Key change in `createApp()`:

```typescript
import { diagnose } from "@3amoncall/diagnosis";
import { DiagnosisRunner } from "./runtime/diagnosis-runner.js";

// Inside createApp(), replace the debouncer onReady:
const apiKeyAvailable = !!process.env["ANTHROPIC_API_KEY"];
const runner = new DiagnosisRunner(store, diagnose, { apiKeyAvailable });

const onReady = async (incidentId: string, packetId: string): Promise<void> => {
  await store.saveThinEvent(/* ... existing thin event save ... */);
  if (apiKeyAvailable) {
    // Inline diagnosis — no external dispatch needed
    await runner.run(incidentId, packetId);
  } else {
    // Fallback: external dispatch (GitHub Actions compat)
    await dispatchThinEvent(/* ... */);
  }
};
```

### Step 7: Run full receiver tests

```bash
cd apps/receiver && pnpm test
```

Expected: All existing tests pass + new DiagnosisRunner tests pass.

### Step 8: Commit

```bash
git add apps/receiver/
git commit -m "feat(receiver): add inline diagnosis via DiagnosisRunner (ADR 0034)"
```

---

## Task 3: CLI フレームワーク導入 — commander + サブコマンド

**Files:**
- Modify: `packages/cli/package.json` (add commander, add `3amoncall` bin)
- Create: `packages/cli/src/cli.ts` (new entry point with commander)
- Create: `packages/cli/src/commands/diagnose.ts` (extracted from current index.ts)
- Create: `packages/cli/src/commands/init.ts` (stub)
- Create: `packages/cli/src/commands/dev.ts` (stub)
- Modify: `packages/cli/src/index.ts` (re-export for backward compat)
- Test: existing `packages/cli/src/__tests__/cli.test.ts` must still pass

### Step 1: Add commander

```bash
cd packages/cli && pnpm add commander
```

### Step 2: Create commands/diagnose.ts

Extract the existing `run()` logic from `index.ts` into `commands/diagnose.ts`. Keep the same behavior.

```typescript
// packages/cli/src/commands/diagnose.ts
import { readFileSync } from "node:fs";
import { IncidentPacketSchema } from "@3amoncall/core";
import { diagnose } from "@3amoncall/diagnosis";

export async function runDiagnose(options: {
  packet: string;
  callbackUrl?: string;
  callbackToken?: string;
}): Promise<void> {
  // ... move existing logic from index.ts run() here
}
```

### Step 3: Create cli.ts with commander

```typescript
// packages/cli/src/cli.ts
import { Command } from "commander";
import { runDiagnose } from "./commands/diagnose.js";

const program = new Command();

program
  .name("3amoncall")
  .description("3amoncall — serverless incident diagnosis")
  .version("0.1.0");

program
  .command("diagnose")
  .description("Run LLM diagnosis on a local incident packet")
  .requiredOption("--packet <path>", "Path to incident packet JSON")
  .option("--callback-url <url>", "POST diagnosis result to this URL")
  .option("--callback-token <token>", "Bearer token for callback")
  .action(async (opts) => {
    await runDiagnose(opts);
  });

program
  .command("init")
  .description("Set up OTel SDK in your application")
  .option("--upgrade", "Switch from local to production Receiver URL")
  .action(async (opts) => {
    const { runInit } = await import("./commands/init.js");
    await runInit(opts);
  });

program
  .command("dev")
  .description("Start a local 3amoncall Receiver")
  .option("--port <port>", "Port to listen on", "3333")
  .action(async (opts) => {
    const { runDev } = await import("./commands/dev.js");
    await runDev(opts);
  });

program.parse();
```

### Step 4: Update package.json bin field

```json
{
  "bin": {
    "3amoncall": "./dist/cli.js",
    "3amoncall-cli": "./dist/cli.js"
  }
}
```

### Step 5: Update index.ts for backward compat

Keep `run()` export for existing tests, delegate to `runDiagnose()`.

### Step 6: Create stub commands

```typescript
// packages/cli/src/commands/init.ts
export async function runInit(options: { upgrade?: boolean }): Promise<void> {
  console.log("3amoncall init — not yet implemented");
  process.exit(1);
}
```

```typescript
// packages/cli/src/commands/dev.ts
export async function runDev(options: { port: string }): Promise<void> {
  console.log("3amoncall dev — not yet implemented");
  process.exit(1);
}
```

### Step 7: Run existing tests

```bash
cd packages/cli && pnpm test
```

Expected: All existing tests pass (backward compat preserved).

### Step 8: Commit

```bash
git add packages/cli/
git commit -m "refactor(cli): add commander + subcommand structure (diagnose/init/dev)"
```

---

## Task 4: 3amoncall dev — ローカル Receiver 起動

**Files:**
- Modify: `packages/cli/src/commands/dev.ts`
- Modify: `packages/cli/package.json` (add deps: `@hono/node-server`, `@3amoncall/diagnosis`, `dotenv`)
- Test: `packages/cli/src/__tests__/dev.test.ts`

### Step 1: Add dependencies

```bash
cd packages/cli && pnpm add @hono/node-server dotenv
```

Note: `@3amoncall/diagnosis` is already a workspace dep. `apps/receiver` exports `createApp` but it's not a workspace package. We need to either:
- (A) Import `createApp` from `apps/receiver/src/index.ts` via workspace protocol — but `apps/receiver` is not published as a package
- (B) Move `createApp` to a shared package
- (C) Inline a minimal receiver in the CLI

**Decision: (A) Add `apps/receiver` as workspace dep.**

```bash
cd packages/cli && pnpm add @3amoncall/receiver@workspace:*
```

This requires adding `"name": "@3amoncall/receiver"` and `"exports"` to `apps/receiver/package.json` if not already present.Check `apps/receiver/package.json` — if it already has a name and exports, use it. If not, add:

```json
{
  "exports": {
    ".": "./dist/index.js"
  }
}
```

### Step 2: Write failing test

File: `packages/cli/src/__tests__/dev.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";

describe("3amoncall dev", () => {
  it("starts receiver on specified port with MemoryAdapter", async () => {
    // Test that runDev creates app and listens
    // Mock @hono/node-server to capture serve() call
    const mockServe = vi.fn().mockReturnValue({ close: vi.fn() });
    vi.doMock("@hono/node-server", () => ({ serve: mockServe }));

    const { runDev } = await import("../commands/dev.js");
    // runDev should call serve with port 3333
    // This is an integration-style test — verify the wiring
  });
});
```

### Step 3: Implement runDev

```typescript
// packages/cli/src/commands/dev.ts
import { config } from "dotenv";

export async function runDev(options: { port: string }): Promise<void> {
  config(); // Load .env

  const { serve } = await import("@hono/node-server");
  const { createApp } = await import("@3amoncall/receiver");

  // Force insecure dev mode for local
  process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
  // Immediate diagnosis (no debouncer)
  process.env["DIAGNOSIS_GENERATION_THRESHOLD"] = "0";
  process.env["DIAGNOSIS_MAX_WAIT_MS"] = "0";

  const port = parseInt(options.port, 10);
  const app = createApp(undefined, {
    consoleDist: undefined, // TODO: resolve console dist path
  });

  console.log(`3amoncall Receiver running at http://localhost:${port}`);
  console.log(`Console: http://localhost:${port}`);
  console.log("Using MemoryAdapter (data resets on restart)");

  if (process.env["ANTHROPIC_API_KEY"]) {
    console.log("ANTHROPIC_API_KEY loaded — diagnosis enabled");
  } else {
    console.log("ANTHROPIC_API_KEY not set — diagnosis disabled");
  }

  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
}
```

### Step 4: Run test

```bash
cd packages/cli && pnpm test
```

### Step 5: Manual smoke test

```bash
cd /Users/murase/project/3amoncall
pnpm build
node packages/cli/dist/cli.js dev --port 3333
# Verify: Receiver starts, /healthz returns 200
curl http://localhost:3333/healthz
```

### Step 6: Commit

```bash
git add packages/cli/
git commit -m "feat(cli): add 3amoncall dev command (local Receiver)"
```

---

## Task 5: 3amoncall init — OTel SDK セットアップ

**Files:**
- Modify: `packages/cli/src/commands/init.ts`
- Create: `packages/cli/src/commands/init/detect-framework.ts`
- Create: `packages/cli/src/commands/init/detect-package-manager.ts`
- Create: `packages/cli/src/commands/init/templates.ts`
- Test: `packages/cli/src/__tests__/init.test.ts`

### Step 1: Write failing test for framework detection

```typescript
// packages/cli/src/__tests__/init.test.ts
import { describe, it, expect } from "vitest";
import { detectFramework } from "../commands/init/detect-framework.js";

describe("detectFramework", () => {
  it("detects Next.js from package.json", () => {
    const pkg = { dependencies: { next: "^16.0.0" } };
    expect(detectFramework(pkg)).toBe("nextjs");
  });

  it("detects Express from package.json", () => {
    const pkg = { dependencies: { express: "^5.0.0" } };
    expect(detectFramework(pkg)).toBe("express");
  });

  it("falls back to generic for unknown frameworks", () => {
    const pkg = { dependencies: { koa: "^2.0.0" } };
    expect(detectFramework(pkg)).toBe("generic");
  });
});
```

### Step 2: Implement detect-framework.ts

```typescript
// packages/cli/src/commands/init/detect-framework.ts
export type Framework = "nextjs" | "express" | "generic";

export function detectFramework(pkg: Record<string, unknown>): Framework {
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
  if (deps["next"]) return "nextjs";
  if (deps["express"]) return "express";
  return "generic";
}
```

### Step 3: Write test for package manager detection

```typescript
// packages/cli/src/__tests__/init.test.ts (append)
import { detectPackageManager } from "../commands/init/detect-package-manager.js";

describe("detectPackageManager", () => {
  it("detects pnpm from pnpm-lock.yaml", () => {
    const files = ["pnpm-lock.yaml", "package.json"];
    expect(detectPackageManager(files)).toBe("pnpm");
  });

  it("detects yarn from yarn.lock", () => {
    const files = ["yarn.lock", "package.json"];
    expect(detectPackageManager(files)).toBe("yarn");
  });

  it("detects bun from bun.lockb", () => {
    const files = ["bun.lockb", "package.json"];
    expect(detectPackageManager(files)).toBe("bun");
  });

  it("defaults to npm", () => {
    const files = ["package.json"];
    expect(detectPackageManager(files)).toBe("npm");
  });
});
```

### Step 4: Implement detect-package-manager.ts

```typescript
// packages/cli/src/commands/init/detect-package-manager.ts
export type PackageManager = "pnpm" | "yarn" | "npm" | "bun";

export function detectPackageManager(files: string[]): PackageManager {
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lockb")) return "bun";
  return "npm";
}

export function installCommand(pm: PackageManager): string {
  switch (pm) {
    case "pnpm": return "pnpm add";
    case "yarn": return "yarn add";
    case "bun": return "bun add";
    case "npm": return "npm install";
  }
}
```

### Step 5: Write test for instrumentation template

```typescript
// packages/cli/src/__tests__/init.test.ts (append)
import { getTemplate } from "../commands/init/templates.js";

describe("getTemplate", () => {
  it("returns Next.js instrumentation template", () => {
    const t = getTemplate("nextjs");
    expect(t).toContain("register");
    expect(t).toContain("NodeSDK");
  });

  it("returns generic instrumentation template", () => {
    const t = getTemplate("generic");
    expect(t).toContain("NodeSDK");
    expect(t).not.toContain("register");
  });
});
```

### Step 6: Implement templates.ts

```typescript
// packages/cli/src/commands/init/templates.ts
import type { Framework } from "./detect-framework.js";

export function getTemplate(framework: Framework): string {
  if (framework === "nextjs") {
    return nextjsTemplate;
  }
  return genericTemplate;
}

const nextjsTemplate = `import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

export function register() {
  // Next.js calls this automatically
}
`;

const genericTemplate = `import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
`;

export const OTEL_DEPS = [
  "@opentelemetry/sdk-node",
  "@opentelemetry/auto-instrumentations-node",
  "@opentelemetry/exporter-trace-otlp-http",
] as const;
```

### Step 7: Implement runInit

```typescript
// packages/cli/src/commands/init.ts
import { readFileSync, writeFileSync, readdirSync, existsSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { detectFramework } from "./init/detect-framework.js";
import { detectPackageManager, installCommand } from "./init/detect-package-manager.js";
import { getTemplate, OTEL_DEPS } from "./init/templates.js";

export async function runInit(options: { upgrade?: boolean }): Promise<void> {
  const cwd = process.cwd();

  if (options.upgrade) {
    await runUpgrade(cwd);
    return;
  }

  // 1. Read package.json
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) {
    console.error("No package.json found. Run this in your project root.");
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  // 2. Detect framework & package manager
  const framework = detectFramework(pkg);
  const files = readdirSync(cwd);
  const pm = detectPackageManager(files);

  console.log(`Detected: ${framework} (package.json)`);
  console.log(`Package manager: ${pm}`);

  // 3. Install OTel deps
  const cmd = `${installCommand(pm)} ${OTEL_DEPS.join(" ")}`;
  console.log(`Installing: ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });

  // 4. Generate instrumentation.ts
  const template = getTemplate(framework);
  const instrPath = join(cwd, "instrumentation.ts");
  if (existsSync(instrPath)) {
    console.log("instrumentation.ts already exists — skipping");
  } else {
    writeFileSync(instrPath, template);
    console.log("Generated instrumentation.ts");
  }

  // 5. Append to .env
  const envPath = join(cwd, ".env");
  const envLines = [
    "",
    "# 3amoncall OTel exporter",
    "OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3333/v1",
    'OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer dev-token"',
  ].join("\n");

  appendFileSync(envPath, envLines + "\n");
  console.log("Added OTel config to .env");

  // 6. Framework-specific instructions
  if (framework === "nextjs") {
    console.log("\nNext.js detected — instrumentation.ts will be loaded automatically.");
  } else {
    console.log("\nAdd this to your start script:");
    console.log("  node --import ./instrumentation.js your-app.js");
  }

  console.log("\nDone! Run `npx 3amoncall dev` to start the local Receiver.");
}

async function runUpgrade(cwd: string): Promise<void> {
  // Prompt-less for now: read from args or stdin
  console.log("3amoncall init --upgrade");
  console.log("Update .env with your production Receiver URL and AUTH_TOKEN.");
  console.log("See: https://github.com/tmurase-42/3amoncall#deploy-to-vercel");
  // TODO: interactive prompt for URL + token (add readline or prompts dep)
}
```

### Step 8: Run all tests

```bash
cd packages/cli && pnpm test
```

### Step 9: Manual smoke test

```bash
mkdir /tmp/test-init && cd /tmp/test-init
npm init -y
echo '{"dependencies":{"next":"^16.0.0"}}' > package.json
npx /Users/murase/project/3amoncall/packages/cli/dist/cli.js init
# Verify: instrumentation.ts created, .env updated, deps installed
cat instrumentation.ts
cat .env
```

### Step 10: Commit

```bash
git add packages/cli/
git commit -m "feat(cli): add 3amoncall init command (OTel SDK setup)"
```

---

## Task 6: 3amoncall init --upgrade — ローカル → 本番切り替え

**Files:**
- Modify: `packages/cli/src/commands/init.ts` (implement runUpgrade)
- Modify: `packages/cli/package.json` (add `prompts` or use readline)
- Test: `packages/cli/src/__tests__/init-upgrade.test.ts`

### Step 1: Write failing test

```typescript
// packages/cli/src/__tests__/init-upgrade.test.ts
import { describe, it, expect } from "vitest";
import { updateEnvFile } from "../commands/init.js";

describe("updateEnvFile", () => {
  it("replaces localhost endpoint with production URL", () => {
    const input = [
      "SOME_VAR=value",
      "OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3333/v1",
      'OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer dev-token"',
    ].join("\n");

    const result = updateEnvFile(input, {
      endpoint: "https://my-app.vercel.app/v1",
      token: "real-token-123",
    });

    expect(result).toContain("OTEL_EXPORTER_OTLP_ENDPOINT=https://my-app.vercel.app/v1");
    expect(result).toContain('Authorization=Bearer real-token-123');
    expect(result).toContain("SOME_VAR=value");
  });
});
```

### Step 2: Implement updateEnvFile + interactive runUpgrade

Use `node:readline` for interactive prompts (no extra dependency needed).

### Step 3: Run tests

```bash
cd packages/cli && pnpm test
```

### Step 4: Commit

```bash
git add packages/cli/
git commit -m "feat(cli): add 3amoncall init --upgrade (local → production)"
```

---

## Task 7: README Getting Started

**Files:**
- Modify: `README.md`

### Step 1: Write Getting Started section

Structure:
1. Quick Start (Local, 5 minutes)
2. Deploy to Vercel (Production)
3. Environment Variables reference
4. Security (spending limit recommendation)

### Step 2: Review and commit

```bash
git add README.md
git commit -m "docs: add Getting Started guide to README"
```

---

## Dependency Order

```
Task 1 (deploy.json) ─────────────────────────────────┐
Task 2 (Receiver内診断) ──────────────────────────────┤
Task 3 (CLI framework) ──┬── Task 4 (dev) ────────────┤
                         ├── Task 5 (init) ────────────┤
                         └── Task 6 (init --upgrade) ──┤
                                                       └── Task 7 (README)
```

Tasks 1, 2, 3 are independent and can run in parallel.
Tasks 4, 5, 6 depend on Task 3.
Task 7 depends on all others.

## Estimated Scope

| Task | Estimated effort |
|------|-----------------|
| 1. deploy.json | 10 min |
| 2. Receiver内診断 | 30 min |
| 3. CLI framework | 20 min |
| 4. 3amoncall dev | 20 min |
| 5. 3amoncall init | 30 min |
| 6. init --upgrade | 15 min |
| 7. README | 15 min |
| **Total** | **~2.5h** |
