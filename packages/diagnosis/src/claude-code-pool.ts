/**
 * Persistent Claude Code CLI subprocess pool.
 *
 * Instead of spawning a new `claude -p` process per LLM call (~6s cold start),
 * this module keeps a long-lived process using `--input-format stream-json
 * --output-format stream-json`. Each generate() call writes a user message to
 * stdin and reads the assistant response from stdout NDJSON events.
 *
 * Because stream-json accumulates conversation context, each process is
 * recycled after MAX_CALLS_PER_PROCESS to prevent context bloat. Processes
 * are keyed by model so switching models spawns a separate worker.
 */

import { spawn, type ChildProcess } from "node:child_process";

// ── Configuration ───────────────────────────────────────────────────────

const DEFAULT_MODEL_KEY = "__default__";
const MAX_CALLS_PER_PROCESS = 8;
const RESPONSE_TIMEOUT_MS = 300_000;

// ── Types ───────────────────────────────────────────────────────────────

type PendingRequest = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ManagedProcess = {
  child: ChildProcess;
  callCount: number;
  pending: PendingRequest | null;
  buffer: string;
  ready: boolean;
  dead: boolean;
  modelKey: string;
  env: NodeJS.ProcessEnv;
};

// ── Queue for serialized access ─────────────────────────────────────────

type QueuedCall = {
  prompt: string;
  model: string | undefined;
  env: NodeJS.ProcessEnv;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
};

const queue: QueuedCall[] = [];
let processing = false;

// ── Process pool ────────────────────────────────────────────────────────

const pool = new Map<string, ManagedProcess>();

function modelKey(model: string | undefined): string {
  return model ?? DEFAULT_MODEL_KEY;
}

function buildArgs(model: string | undefined): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
  ];
  if (model) {
    args.push("--model", model);
  }
  return args;
}

function buildEnv(callerEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...callerEnv };
  // Never pass ANTHROPIC_API_KEY — forces Claude CLI to use subscription auth
  delete env["ANTHROPIC_API_KEY"];
  return env;
}

function spawnProcess(model: string | undefined, env: NodeJS.ProcessEnv): ManagedProcess {
  const key = modelKey(model);
  const args = buildArgs(model);
  const spawnEnv = buildEnv(env);

  const child = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: spawnEnv,
  });

  const managed: ManagedProcess = {
    child,
    callCount: 0,
    pending: null,
    buffer: "",
    ready: true,
    dead: false,
    modelKey: key,
    env: spawnEnv,
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    managed.buffer += chunk.toString("utf8");
    drainBuffer(managed);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    // Log stderr for debugging but don't fail on it
    const text = chunk.toString("utf8").trim();
    if (text) {
      process.stderr.write(`[claude-pool:${key}:stderr] ${text}\n`);
    }
  });

  child.on("error", (err) => {
    managed.dead = true;
    if (managed.pending) {
      clearTimeout(managed.pending.timer);
      managed.pending.reject(new Error(`claude process error: ${err.message}`));
      managed.pending = null;
    }
    pool.delete(key);
  });

  child.on("close", (code) => {
    managed.dead = true;
    if (managed.pending) {
      clearTimeout(managed.pending.timer);
      managed.pending.reject(
        new Error(`claude process exited unexpectedly with code ${code}`),
      );
      managed.pending = null;
    }
    pool.delete(key);
  });

  pool.set(key, managed);
  return managed;
}

// ── NDJSON parsing ──────────────────────────────────────────────────────

function drainBuffer(managed: ManagedProcess): void {
  const lines = managed.buffer.split("\n");
  // Keep the last (possibly incomplete) line in the buffer
  managed.buffer = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Not valid JSON, skip
      continue;
    }

    if (!managed.pending) continue;

    // The stream-json output emits various event types.
    // We look for the result message which contains the assistant's response.
    // Format: {"type":"result","subtype":"success","result":"<text>",...}
    if (event["type"] === "result" && typeof event["result"] === "string") {
      const text = event["result"] as string;
      clearTimeout(managed.pending.timer);
      managed.pending.resolve(text);
      managed.pending = null;
      continue;
    }

    // Alternative: {"type":"result","subtype":"success","result":"..."} with content blocks
    // Some versions emit content blocks in a message structure
    if (event["type"] === "result" && event["subtype"] === "success") {
      // Try to extract text from the result field
      const result = event["result"];
      if (typeof result === "string") {
        clearTimeout(managed.pending.timer);
        managed.pending.resolve(result);
        managed.pending = null;
        continue;
      }
    }

    // Handle error results
    if (event["type"] === "result" && event["subtype"] === "error") {
      const errorMsg = typeof event["error"] === "string"
        ? event["error"]
        : "claude stream-json returned an error result";
      clearTimeout(managed.pending.timer);
      managed.pending.reject(new Error(errorMsg));
      managed.pending = null;
      continue;
    }
  }
}

// ── Core generate (internal, not queued) ────────────────────────────────

function generateInternal(
  prompt: string,
  model: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const key = modelKey(model);
  let managed = pool.get(key);

  // Recycle if the process has been used too many times or is dead
  if (managed && (managed.dead || managed.callCount >= MAX_CALLS_PER_PROCESS)) {
    killProcess(managed);
    managed = undefined;
  }

  if (!managed) {
    managed = spawnProcess(model, env);
  }

  managed.callCount++;

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (managed!.pending) {
        managed!.pending = null;
        reject(new Error(`claude stream-json response timed out after ${RESPONSE_TIMEOUT_MS}ms`));
        // Kill the hung process
        killProcess(managed!);
      }
    }, RESPONSE_TIMEOUT_MS);

    managed!.pending = { resolve, reject, timer };

    // Write user message as NDJSON to stdin
    const message = JSON.stringify({
      type: "user",
      content: prompt,
    });

    try {
      managed!.child.stdin?.write(message + "\n");
    } catch (err) {
      clearTimeout(timer);
      managed!.pending = null;
      reject(
        new Error(`Failed to write to claude stdin: ${err instanceof Error ? err.message : String(err)}`),
      );
      killProcess(managed!);
    }
  });
}

// ── Queue processor ─────────────────────────────────────────────────────

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const call = queue.shift()!;
    try {
      const result = await generateInternal(call.prompt, call.model, call.env);
      call.resolve(result);
    } catch (err) {
      call.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  processing = false;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Pre-spawn a claude process for the given model so the first real call is fast.
 */
export function warmUp(model?: string, env?: NodeJS.ProcessEnv): void {
  const key = modelKey(model);
  if (pool.has(key)) return;
  spawnProcess(model, env ?? process.env);
  process.stdout.write(`[claude-pool] warmed up process for model=${model ?? "default"}\n`);
}

/**
 * Send a prompt to the persistent claude process and return the response text.
 * Calls are serialized per-model to avoid interleaving stdin/stdout.
 */
export function generate(
  prompt: string,
  model?: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    queue.push({
      prompt,
      model,
      env: env ?? process.env,
      resolve,
      reject,
    });
    void processQueue();
  });
}

/**
 * Check if a persistent process is available for the given model.
 */
export function hasProcess(model?: string): boolean {
  const key = modelKey(model);
  const managed = pool.get(key);
  return !!managed && !managed.dead;
}

/**
 * Kill a specific managed process.
 */
function killProcess(managed: ManagedProcess): void {
  managed.dead = true;
  if (managed.pending) {
    clearTimeout(managed.pending.timer);
    managed.pending.reject(new Error("claude process killed"));
    managed.pending = null;
  }
  try {
    managed.child.kill("SIGTERM");
  } catch {
    // ignore
  }
  pool.delete(managed.modelKey);
}

/**
 * Shut down all persistent claude processes.
 */
export function shutdown(): void {
  for (const managed of pool.values()) {
    killProcess(managed);
  }
  pool.clear();
  queue.length = 0;
  processing = false;
  process.stdout.write("[claude-pool] all processes shut down\n");
}
