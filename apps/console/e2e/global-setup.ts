import { createServer } from "http";
import type { Server } from "http";
import { spawn } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { E2E_STORAGE_STATE } from "../playwright.config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIVER_URL = "http://localhost:4319";
const TOKEN = "e2e-test-token";
const MOCK_ANTHROPIC_PORT = 4320;
const MOCK_ANTHROPIC_REPLY = "Disable the Stripe retry loop immediately to stop the cascade.";

async function waitForReady(url: string, maxMs = 15_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      // Any response (even 401) means the server is up
      return;
    } catch {
      await new Promise<void>((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`Receiver did not start within ${maxMs}ms at ${url}`);
}

function startMockAnthropicServer(): Promise<Server> {
  const server = createServer((req, res) => {
    // Drain request body before responding to avoid ECONNRESET
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
  // Start mock Anthropic server so the receiver's chat endpoint doesn't hit the real API
  const mockServer = await startMockAnthropicServer();
  // Store on globalThis — setup and teardown run in the same Playwright process
  (globalThis as Record<string, unknown>)["__mockAnthropicServer"] = mockServer;

  // Start receiver on port 4319 to avoid conflicts with default port 4318
  const receiverRoot = path.resolve(__dirname, "../../../apps/receiver");
  const receiverProcess = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: receiverRoot,
    env: {
      ...process.env,
      PORT: "4319",
      RECEIVER_AUTH_TOKEN: TOKEN,
      ANTHROPIC_BASE_URL: `http://localhost:${MOCK_ANTHROPIC_PORT}`,
      ANTHROPIC_API_KEY: "e2e-mock-key",
    },
    stdio: "pipe",
  });

  // Store PID in a temp file so globalTeardown (which may run in a separate
  // Node.js context) can reliably read it across process boundaries.
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

  // Wait for receiver to respond (401 without token, but that means it's up)
  await waitForReady(`${RECEIVER_URL}/api/incidents`);

  // Seed 5 incidents via the seed-dev.ts script
  const seedPath = path.resolve(
    __dirname,
    "../../../apps/receiver/src/scripts/seed-dev.ts",
  );
  await new Promise<void>((resolve, reject) => {
    const seedProc = spawn("npx", ["tsx", seedPath, `--url=${RECEIVER_URL}`], {
      // cwd must be the receiver root so `npx tsx` resolves from receiver's node_modules
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
  // global-setup runs before any test context is created, so this file is
  // guaranteed to exist when Playwright reads use.storageState.
  mkdirSync(path.dirname(E2E_STORAGE_STATE), { recursive: true });
  const storageState = {
    cookies: [],
    origins: [
      {
        origin: "http://localhost:5174",
        localStorage: [{ name: "receiver_auth_token", value: TOKEN }],
      },
    ],
  };
  writeFileSync(E2E_STORAGE_STATE, JSON.stringify(storageState), "utf8");

  // Warm up: fetch the first incident's evidence endpoint so the receiver
  // pre-computes curated evidence (baseline selection, reasoning structure, etc.)
  // before tests start. Without this, the first test pays the cold-start cost
  // and times out in CI.
  const listRes = await fetch(`${RECEIVER_URL}/api/incidents?limit=1`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (listRes.ok) {
    const { items } = (await listRes.json()) as { items?: Array<{ incidentId: string }> };
    const firstId = items?.[0]?.incidentId;
    if (firstId) {
      await fetch(`${RECEIVER_URL}/api/incidents/${encodeURIComponent(firstId)}/evidence`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }).catch(() => {/* warm-up failure is non-fatal */});
    }
  }

  console.log("[E2E] Receiver ready and seeded with 5 incidents");
}
