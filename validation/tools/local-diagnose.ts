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
 *   ANTHROPIC_API_KEY   - Required for LLM calls
 *   MAX_DIAGNOSES       - Hard limit on LLM calls (default: 1)
 *   POLL_INTERVAL_MS    - Polling interval in ms (default: 5000)
 *   POLL_ROUNDS         - Max polling rounds before exit (default: 12)
 *   DIAGNOSIS_MODEL     - Model to use (default: claude-sonnet-4-6)
 */
import { diagnose } from "@3amoncall/diagnosis";
import type { IncidentPacket, DiagnosisResult } from "@3amoncall/core";

const BASE_URL = process.env["RECEIVER_BASE_URL"] ?? "http://localhost:4319";
const MAX_DIAGNOSES = Number(process.env["MAX_DIAGNOSES"] ?? "1");
const POLL_INTERVAL_MS = Number(process.env["POLL_INTERVAL_MS"] ?? "5000");
const POLL_ROUNDS = Number(process.env["POLL_ROUNDS"] ?? "12");
const MODEL = process.env["DIAGNOSIS_MODEL"] ?? "claude-sonnet-4-6";

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

async function runDiagnoses(diagnosisCount: number): Promise<number> {
  const incidents = await listIncidents();
  const pending = incidents.filter((i) => !i.diagnosisResult);

  if (pending.length === 0) {
    console.log("[local-diagnose] no pending incidents");
    return diagnosisCount;
  }

  for (const incident of pending) {
    if (diagnosisCount >= MAX_DIAGNOSES) {
      console.warn(`[local-diagnose] reached MAX_DIAGNOSES=${MAX_DIAGNOSES}, stopping`);
      return diagnosisCount;
    }
    console.log(
      `[local-diagnose] diagnosing ${incident.incidentId} (call ${diagnosisCount + 1}/${MAX_DIAGNOSES})`,
    );
    try {
      const result = await diagnose(incident.packet, { model: MODEL });
      await postDiagnosis(incident.incidentId, result);
      console.log(
        `[local-diagnose] ✓ ${incident.incidentId} — ${result.summary.what_happened.slice(0, 80)}…`,
      );
      diagnosisCount++;
    } catch (err) {
      console.error(`[local-diagnose] ✗ ${incident.incidentId}:`, err);
    }
  }
  return diagnosisCount;
}

async function main() {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    console.error("[local-diagnose] ANTHROPIC_API_KEY is not set");
    process.exit(1);
  }
  console.log(
    `[local-diagnose] starting — base=${BASE_URL} model=${MODEL} maxCalls=${MAX_DIAGNOSES}`,
  );

  let diagnosisCount = 0;
  for (let round = 0; round < POLL_ROUNDS; round++) {
    diagnosisCount = await runDiagnoses(diagnosisCount);
    if (diagnosisCount >= MAX_DIAGNOSES) break;
    if (round < POLL_ROUNDS - 1) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
  console.log(`[local-diagnose] done — total diagnoses run: ${diagnosisCount}`);
}

main().catch((err) => {
  console.error("[local-diagnose] fatal:", err);
  process.exit(1);
});
