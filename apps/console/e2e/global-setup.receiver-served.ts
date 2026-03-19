/**
 * global-setup for receiver-served E2E.
 * Identical to global-setup.ts except the receiver is started with
 * CONSOLE_DIST_PATH so it serves the built console dist instead of
 * redirecting to Vite dev server.
 *
 * Run `pnpm build` before using this config.
 */
import { createServer } from "http";
import type { Server } from "http";
import { spawn } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { E2E_RECEIVER_SERVED_STORAGE_STATE } from "../playwright.receiver-served.config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIVER_URL = "http://localhost:4321";
const TOKEN = "e2e-test-token";
const MOCK_ANTHROPIC_PORT = 4322;
const MOCK_ANTHROPIC_REPLY = "Disable the Stripe retry loop immediately to stop the cascade.";

async function waitForReady(url: string, maxMs = 15_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise<void>((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`Receiver did not start within ${maxMs}ms at ${url}`);
}

function startMockAnthropicServer(): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/v1/messages") {
        const body = JSON.stringify({
          id: "msg_e2e_mock",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: MOCK_ANTHROPIC_REPLY }],
          model: "claude-haiku-4-5-20251001",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 50, output_tokens: 15 },
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise((resolve) => server.listen(MOCK_ANTHROPIC_PORT, () => resolve(server)));
}

export default async function globalSetup(): Promise<void> {
  const mockServer = await startMockAnthropicServer();
  (globalThis as Record<string, unknown>)["__mockAnthropicServer"] = mockServer;

  const receiverRoot = path.resolve(__dirname, "../../../apps/receiver");
  // Point receiver at the built console dist so it serves the SPA
  const consoleDist = path.resolve(__dirname, "../dist");

  const receiverProcess = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: receiverRoot,
    env: {
      ...process.env,
      PORT: "4321",
      RECEIVER_AUTH_TOKEN: TOKEN,
      ANTHROPIC_BASE_URL: `http://localhost:${MOCK_ANTHROPIC_PORT}`,
      ANTHROPIC_API_KEY: "e2e-mock-key",
      CONSOLE_DIST_PATH: consoleDist,
    },
    stdio: "pipe",
  });

  const pidFile = path.join(tmpdir(), "3amoncall-e2e-receiver.pid");
  writeFileSync(pidFile, String(receiverProcess.pid), "utf8");
  process.env["E2E_RECEIVER_PID_FILE"] = pidFile;

  receiverProcess.stderr?.on("data", (d: Buffer) => {
    if (process.env["DEBUG"]) process.stderr.write(d);
  });
  receiverProcess.stdout?.on("data", (d: Buffer) => {
    if (process.env["DEBUG"]) process.stdout.write(d);
  });

  receiverProcess.on("error", (err) => {
    console.error("[E2E] Failed to start receiver:", err);
  });

  await waitForReady(`${RECEIVER_URL}/api/incidents`);

  const seedPath = path.resolve(
    __dirname,
    "../../../apps/receiver/src/scripts/seed-dev.ts",
  );
  await new Promise<void>((resolve, reject) => {
    const seedProc = spawn("npx", ["tsx", seedPath, `--url=${RECEIVER_URL}`], {
      cwd: receiverRoot,
      env: { ...process.env, RECEIVER_AUTH_TOKEN: TOKEN },
      stdio: "pipe",
    });
    const chunks: Buffer[] = [];
    seedProc.stdout?.on("data", (d: Buffer) => chunks.push(d));
    seedProc.stderr?.on("data", (d: Buffer) => chunks.push(d));
    seedProc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const output = Buffer.concat(chunks).toString();
        reject(new Error(`seed-dev exited with code ${String(code)}: ${output}`));
      }
    });
    seedProc.on("error", reject);
  });

  // Write storageState so the Console SPA has the auth token in localStorage.
  // baseURL is http://localhost:4321 (Receiver serves the SPA directly).
  mkdirSync(path.dirname(E2E_RECEIVER_SERVED_STORAGE_STATE), { recursive: true });
  const storageState = {
    cookies: [],
    origins: [
      {
        origin: "http://localhost:4321",
        localStorage: [{ name: "receiver_auth_token", value: TOKEN }],
      },
    ],
  };
  writeFileSync(E2E_RECEIVER_SERVED_STORAGE_STATE, JSON.stringify(storageState), "utf8");

  console.log("[E2E] Receiver ready (serving console dist) and seeded with 5 incidents");
}
