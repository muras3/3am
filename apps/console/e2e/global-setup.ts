import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIVER_URL = "http://localhost:4319";
const TOKEN = "e2e-test-token";

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

export default async function globalSetup(): Promise<void> {
  // Start receiver on port 4319 to avoid conflicts with default port 4318
  const receiverRoot = path.resolve(__dirname, "../../../apps/receiver");
  const receiverProcess = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: receiverRoot,
    env: {
      ...process.env,
      PORT: "4319",
      RECEIVER_AUTH_TOKEN: TOKEN,
    },
    stdio: "pipe",
  });

  // Store PID for teardown
  process.env["E2E_RECEIVER_PID"] = String(receiverProcess.pid);

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

  console.log("[E2E] Receiver ready and seeded with 5 incidents");
}
