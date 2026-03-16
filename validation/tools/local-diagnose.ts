/**
 * Local diagnosis runner for development / validation.
 *
 * Polls the Receiver for incidents that have no diagnosisResult yet,
 * runs diagnose() on each, and POSTs the result back.
 *
 * Run from the monorepo root via validation/run.sh, or manually:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx validation/tools/local-diagnose.ts
 *
 * Environment variables:
 *   RECEIVER_BASE_URL   - Default: http://localhost:4319
 *   RECEIVER_AUTH_TOKEN - Bearer token (omit if ALLOW_INSECURE_DEV_MODE=true)
 *   ANTHROPIC_API_KEY   - Required for LLM calls (not needed when USE_CLAUDE_CLI=1)
 *   USE_CLAUDE_CLI      - Set to "1" to use claude/codex CLI instead of Anthropic SDK
 *   MAX_DIAGNOSES       - Hard limit on LLM calls (default: 1)
 *   POLL_INTERVAL_MS    - Polling interval in ms (default: 5000)
 *   POLL_ROUNDS         - Max polling rounds before exit (default: 12)
 *   DIAGNOSIS_MODEL     - Model to use (default: claude-sonnet-4-6)
 *                         claude-* → claude --print (Max plan, no API charge)
 *                         gpt-*   → codex exec    (OpenAI subscription)
 */
import { spawnSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { diagnose, buildPrompt, parseResult } from "@3amoncall/diagnosis";
import type { IncidentPacket, DiagnosisResult } from "@3amoncall/core";

const BASE_URL = process.env["RECEIVER_BASE_URL"] ?? "http://localhost:4319";
const MAX_DIAGNOSES = Number(process.env["MAX_DIAGNOSES"] ?? "1");
const POLL_INTERVAL_MS = Number(process.env["POLL_INTERVAL_MS"] ?? "5000");
const POLL_ROUNDS = Number(process.env["POLL_ROUNDS"] ?? "12");
const MODEL = process.env["DIAGNOSIS_MODEL"] ?? "claude-sonnet-4-6";
const USE_CLAUDE_CLI = process.env["USE_CLAUDE_CLI"] === "1";

interface Incident {
  incidentId: string;
  packet: IncidentPacket;
  diagnosisResult?: DiagnosisResult;
}

function authHeader(): Record<string, string> {
  const token = process.env["RECEIVER_AUTH_TOKEN"];
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function listIncidents(): Promise<Incident[]> {
  const res = await fetch(`${BASE_URL}/api/incidents?limit=100`, {
    headers: authHeader(),
  });
  if (!res.ok) throw new Error(`GET /api/incidents → ${res.status}`);
  const page = (await res.json()) as { items: Incident[] };
  return page.items;
}

async function postDiagnosis(incidentId: string, result: DiagnosisResult): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/diagnosis/${incidentId}`, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(result),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST /api/diagnosis/${incidentId} → ${res.status}: ${body}`);
  }
}

/**
 * Calls the appropriate CLI backend based on model prefix.
 * claude-* → claude --print (Max plan)
 * gpt-*    → codex exec     (OpenAI subscription)
 */
function callCli(prompt: string, model: string): string {
  if (model.startsWith("claude-")) {
    // Write prompt to temp file and redirect stdin from it via shell.
    // spawnSync({ input }) doesn't reliably reach claude --print when
    // invoked from npx tsx, and -p with $(cat) hits ARG_MAX for large prompts.
    const tmpFile = join(tmpdir(), `3amoncall-prompt-${Date.now()}.txt`);
    try {
      writeFileSync(tmpFile, prompt, "utf8");
      const proc = spawnSync("sh", ["-c", `claude --print --model "${model}" < "${tmpFile}"`], {
        encoding: "utf8",
        timeout: 180_000,
      });
      if (proc.status !== 0) {
        throw new Error(`claude --print failed (exit ${proc.status}): ${proc.stderr}`);
      }
      return proc.stdout;
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }
  // OpenAI via codex CLI (e.g. gpt-5.4)
  const proc = spawnSync("codex", ["exec", "-c", `model="${model}"`], {
    input: prompt,
    encoding: "utf8",
    timeout: 300_000,
  });
  if (proc.status !== 0) {
    throw new Error(`codex exec failed (exit ${proc.status}): ${proc.stderr}`);
  }
  return proc.stdout;
}

async function diagnoseSingle(incident: Incident): Promise<DiagnosisResult> {
  if (USE_CLAUDE_CLI) {
    const prompt = buildPrompt(incident.packet);
    const raw = callCli(prompt, MODEL);
    return parseResult(raw, {
      incidentId: incident.incidentId,
      packetId: incident.packet.packetId,
      model: `cli/${MODEL}`,
      promptVersion: "v5",
    });
  }
  return diagnose(incident.packet, { model: MODEL });
}

async function runDiagnoses(
  diagnosisCount: number,
): Promise<{ count: number; hadPending: boolean }> {
  const incidents = await listIncidents();
  const pending = incidents.filter((i) => !i.diagnosisResult);

  if (pending.length === 0) {
    console.log("[local-diagnose] no pending incidents");
    return { count: diagnosisCount, hadPending: false };
  }

  for (const incident of pending) {
    if (diagnosisCount >= MAX_DIAGNOSES) {
      console.warn(`[local-diagnose] reached MAX_DIAGNOSES=${MAX_DIAGNOSES}, stopping`);
      return { count: diagnosisCount, hadPending: true };
    }
    console.log(
      `[local-diagnose] diagnosing ${incident.incidentId} (call ${diagnosisCount + 1}/${MAX_DIAGNOSES})`,
    );
    try {
      const result = await diagnoseSingle(incident);
      await postDiagnosis(incident.incidentId, result);
      console.log(
        `[local-diagnose] ✓ ${incident.incidentId} — ${result.summary.what_happened.slice(0, 80)}…`,
      );
      diagnosisCount++;
    } catch (err) {
      console.error(`[local-diagnose] ✗ ${incident.incidentId}:`, err);
    }
  }
  return { count: diagnosisCount, hadPending: true };
}

async function main() {
  if (!USE_CLAUDE_CLI && !process.env["ANTHROPIC_API_KEY"]) {
    console.error("[local-diagnose] ANTHROPIC_API_KEY is not set");
    process.exit(1);
  }
  const backend = USE_CLAUDE_CLI ? `cli/${MODEL}` : `sdk/${MODEL}`;
  console.log(
    `[local-diagnose] starting — base=${BASE_URL} backend=${backend} maxCalls=${MAX_DIAGNOSES}`,
  );

  let diagnosisCount = 0;
  let sawPending = false;
  for (let round = 0; round < POLL_ROUNDS; round++) {
    const result = await runDiagnoses(diagnosisCount);
    diagnosisCount = result.count;
    if (result.hadPending) sawPending = true;
    if (diagnosisCount >= MAX_DIAGNOSES) break;
    if (round < POLL_ROUNDS - 1) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
  console.log(`[local-diagnose] done — total diagnoses run: ${diagnosisCount}`);

  // Fail non-zero when pending incidents existed but no diagnosis was posted.
  // This lets run.sh distinguish a broken diagnosis step from a clean no-op.
  if (sawPending && diagnosisCount === 0) {
    console.error("[local-diagnose] pending incidents found but no diagnosis succeeded");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[local-diagnose] fatal:", err);
  process.exit(1);
});
