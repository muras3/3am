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
const DEFAULT_RESPONSE_TIMEOUT_MS = 300_000;

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
};

// ── Per-model queues for serialized access ──────────────────────────────

type QueuedCall = {
  prompt: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
};

/** Per-model queue + processing flag */
type ModelQueue = {
  items: QueuedCall[];
  processing: boolean;
};

const modelQueues = new Map<string, ModelQueue>();

function getModelQueue(key: string): ModelQueue {
  let mq = modelQueues.get(key);
  if (!mq) {
    mq = { items: [], processing: false };
    modelQueues.set(key, mq);
  }
  return mq;
}

// ── Process pool ────────────────────────────────────────────────────────

const pool = new Map<string, ManagedProcess>();

function modelKeyFor(model: string | undefined): string {
  return model ?? DEFAULT_MODEL_KEY;
}

function buildArgs(model: string | undefined): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--tools", "",
    "--strict-mcp-config",
    "--thinking", "disabled",
    "--system-prompt", "You are a text processing assistant for incident analysis. Follow instructions precisely. Respond only with the requested output format. Never use tools.",
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
  const key = modelKeyFor(model);
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
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    managed.buffer += chunk.toString("utf8");
    drainBuffer(managed);
  });

  child.stderr?.on("data", (_chunk: Buffer) => {
    // Silently discard stderr to avoid leaking sensitive CLI output
  });

  // [Codex high] Handle stdin pipe errors to prevent unhandled EPIPE crash
  child.stdin?.on("error", (err) => {
    managed.dead = true;
    if (managed.pending) {
      clearTimeout(managed.pending.timer);
      managed.pending.reject(new Error(`claude stdin error: ${err.message}`));
      managed.pending = null;
    }
    pool.delete(key);
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
    // [Codex medium] Flush remaining buffer on close
    if (managed.buffer.trim()) {
      drainLine(managed, managed.buffer.trim());
      managed.buffer = "";
    }
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
    drainLine(managed, line.trim());
  }
}

function drainLine(managed: ManagedProcess, trimmed: string): void {
  if (!trimmed || !managed.pending) return;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }

  // The stream-json output emits various event types.
  // We look for the result message which contains the assistant's response.
  if (event["type"] === "result" && typeof event["result"] === "string") {
    clearTimeout(managed.pending.timer);
    managed.pending.resolve(event["result"] as string);
    managed.pending = null;
    return;
  }

  if (event["type"] === "result" && event["subtype"] === "success") {
    const result = event["result"];
    if (typeof result === "string") {
      clearTimeout(managed.pending.timer);
      managed.pending.resolve(result);
      managed.pending = null;
      return;
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
  }
}

// ── Core generate (internal, not queued) ────────────────────────────────

function generateInternal(
  prompt: string,
  model: string | undefined,
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<string> {
  const key = modelKeyFor(model);
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
  const effectiveTimeout = timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (managed!.pending) {
        managed!.pending = null;
        reject(new Error(`claude stream-json response timed out after ${effectiveTimeout}ms`));
        killProcess(managed!);
      }
    }, effectiveTimeout);

    managed!.pending = { resolve, reject, timer };

    // Write user message as NDJSON to stdin
    // stream-json protocol requires: {type:"user", message:{role:"user", content:"..."}}
    const message = JSON.stringify({
      type: "user",
      message: { role: "user", content: prompt },
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

// ── Per-model queue processor ───────────────────────────────────────────
// [Codex high] Serialization is now per-model, not global

async function processModelQueue(key: string): Promise<void> {
  const mq = getModelQueue(key);
  if (mq.processing) return;
  mq.processing = true;

  while (mq.items.length > 0) {
    const call = mq.items.shift()!;
    try {
      const result = await generateInternal(call.prompt, key === DEFAULT_MODEL_KEY ? undefined : key, call.env, call.timeoutMs);
      call.resolve(result);
    } catch (err) {
      call.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  mq.processing = false;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Pre-spawn a claude process for the given model so the first real call is fast.
 */
export function warmUp(model?: string, env?: NodeJS.ProcessEnv): void {
  const key = modelKeyFor(model);
  if (pool.has(key)) return;
  spawnProcess(model, env ?? process.env);
  process.stdout.write(`[claude-pool] warmed up process for model=${model ?? "default"}\n`);
}

/**
 * Spawn + send a priming prompt to absorb hook/init overhead.
 * Subsequent calls reuse the warmed process and respond in ~3-5s.
 */
export async function prime(model?: string, env?: NodeJS.ProcessEnv): Promise<void> {
  warmUp(model, env);
  const t0 = Date.now();
  await generate("respond with: ready", model, env);
  process.stdout.write(`[claude-pool] primed in ${Date.now() - t0}ms for model=${model ?? "default"}\n`);
}

/**
 * Send a prompt to the persistent claude process and return the response text.
 * Calls are serialized per-model to avoid interleaving stdin/stdout.
 */
export function generate(
  prompt: string,
  model?: string,
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<string> {
  const key = modelKeyFor(model);
  return new Promise<string>((resolve, reject) => {
    getModelQueue(key).items.push({
      prompt,
      env: env ?? process.env,
      timeoutMs,
      resolve,
      reject,
    });
    void processModelQueue(key);
  });
}

/**
 * Check if a persistent process is available for the given model.
 */
export function hasProcess(model?: string): boolean {
  const key = modelKeyFor(model);
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
    // [Codex medium] Force kill after 5s if SIGTERM ignored
    setTimeout(() => {
      try { managed.child.kill("SIGKILL"); } catch { /* already dead */ }
    }, 5000).unref();
  } catch {
    // ignore
  }
  pool.delete(managed.modelKey);
}

/**
 * Shut down all persistent claude processes.
 * [Codex high] Rejects all queued requests before clearing.
 */
export function shutdown(): void {
  for (const managed of pool.values()) {
    killProcess(managed);
  }
  pool.clear();

  // Reject all queued requests
  for (const [, mq] of modelQueues) {
    for (const call of mq.items) {
      call.reject(new Error("claude pool shutting down"));
    }
    mq.items.length = 0;
    mq.processing = false;
  }
  modelQueues.clear();

  process.stdout.write("[claude-pool] all processes shut down\n");
}
