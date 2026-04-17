import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const RECEIVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEV_AUTH_TOKEN = "cf-queue-local-token";

const diagnosisReply = JSON.stringify({
  summary: {
    what_happened: "Stripe 429s caused checkout 500s.",
    root_cause_hypothesis: "Retry amplification exhausted the checkout path.",
  },
  recommendation: {
    immediate_action: "Disable the retry loop.",
    action_rationale_short: "It cuts the overload at the source.",
    do_not: "Do not increase timeout budgets.",
  },
  reasoning: {
    causal_chain: [
      { type: "external", title: "Stripe 429", detail: "Rate limiting started." },
      { type: "system", title: "Retry loop", detail: "The worker retried too aggressively." },
      { type: "impact", title: "Checkout 500", detail: "The route failed for customers." },
    ],
  },
  operator_guidance: {
    watch_items: [{ label: "Error rate", state: "must fall", status: "watch" }],
    operator_checks: ["Confirm 429s flatten within 60s."],
  },
  confidence: {
    confidence_assessment: "High confidence.",
    uncertainty: "Stripe quota internals are not visible.",
  },
});

const narrativeReply = JSON.stringify({
  headline: "Stripe retry amplification is driving checkout failures",
  whyThisAction: "Disabling the retry loop removes the extra dependency pressure immediately.",
  confidenceSummary: {
    basis: "429s and checkout failures move together in the same window.",
    risk: "If retries remain enabled, pressure returns quickly.",
  },
  proofCards: [
    { id: "trigger", label: "External Trigger", summary: "Stripe 429s are the starting signal." },
    { id: "design_gap", label: "Design Gap", summary: "Retries amplify the dependency failure." },
    { id: "recovery", label: "Recovery Signal", summary: "Recovery is pending once retries stop." },
  ],
  qa: {
    question: "Why is checkout failing?",
    answer: "Stripe started returning 429s and the retry loop amplified the failure.",
    answerEvidenceRefs: [],
    evidenceBindings: [],
    followups: [{ question: "Did the 429s stop?", targetEvidenceKinds: ["logs"] }],
    noAnswerReason: "Local queue smoke response.",
  },
  sideNotes: [
    { title: "Confidence", text: "High confidence from aligned traces and logs.", kind: "confidence" },
  ],
  absenceEvidence: [],
});

async function waitFor(
  url: string,
  check: (response: Response) => Promise<boolean>,
  maxMs = 30_000,
  token?: string,
): Promise<Response> {
  const deadline = Date.now() + maxMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (await check(response)) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? `: ${String(lastError)}` : ""}`);
}

function startMockAnthropicServer(port: number): Promise<Server> {
  let requestCount = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/messages") {
        res.writeHead(404);
        res.end();
        return;
      }
      requestCount += 1;
      const text = requestCount === 1 ? diagnosisReply : narrativeReply;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: `msg_${requestCount}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text }],
        model: "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("Failed to allocate a free port");
  return port;
}

function writeDevVars(mockAnthropicPort: number): () => void {
  const devVarsPath = path.join(RECEIVER_ROOT, ".dev.vars");
  const previous = existsSync(devVarsPath) ? readFileSync(devVarsPath, "utf8") : null;
  writeFileSync(
    devVarsPath,
    `ANTHROPIC_API_KEY=local-mock-key\nANTHROPIC_BASE_URL=http://127.0.0.1:${mockAnthropicPort}\nRECEIVER_AUTH_TOKEN=${DEV_AUTH_TOKEN}\n`,
    "utf8",
  );
  return () => {
    if (previous === null) {
      rmSync(devVarsPath, { force: true });
    } else {
      writeFileSync(devVarsPath, previous, "utf8");
    }
  };
}

function startWranglerDev(receiverPort: number, persistPath: string): ChildProcess {
  return spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(receiverPort), "--ip", "127.0.0.1", "--persist-to", persistPath], {
    cwd: RECEIVER_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function main(): Promise<void> {
  const receiverPort = await getFreePort();
  const mockAnthropicPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${receiverPort}`;
  const mockServer = await startMockAnthropicServer(mockAnthropicPort);
  const restoreDevVars = writeDevVars(mockAnthropicPort);
  const persistPath = mkdtempSync(path.join(tmpdir(), "3am-cf-queue-"));
  const wrangler = startWranglerDev(receiverPort, persistPath);

  wrangler.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  wrangler.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));

  try {
    await waitFor(`${baseUrl}/healthz`, async (response) => response.ok, 45_000);

    const ingest = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DEV_AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "web" } },
                { key: "deployment.environment.name", value: { stringValue: "production" } },
              ],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "11111111111111111111111111111111",
                    spanId: "2222222222222222",
                    name: "POST /checkout",
                    startTimeUnixNano: "1741392000000000000",
                    endTimeUnixNano: "1741392000500000000",
                    status: { code: 2 },
                    attributes: [
                      { key: "http.route", value: { stringValue: "/checkout" } },
                      { key: "http.response.status_code", value: { intValue: 500 } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    if (!ingest.ok) {
      throw new Error(`ingest failed: ${ingest.status} ${await ingest.text()}`);
    }

    const incidentsRes = await waitFor(`${baseUrl}/api/incidents`, async (response) => {
      if (!response.ok) return false;
      const page = await response.clone().json() as { items: Array<{ incidentId: string }> };
      return page.items.length > 0;
    }, 45_000, DEV_AUTH_TOKEN);
    const page = await incidentsRes.json() as { items: Array<{ incidentId: string }> };
    const incidentId = page.items[0]?.incidentId;
    if (!incidentId) throw new Error("No incident created by wrangler queue smoke");

    const detailRes = await waitFor(`${baseUrl}/api/incidents/${incidentId}`, async (response) => {
      if (!response.ok) return false;
      const body = await response.clone().json() as { state?: { diagnosis?: string } };
      return body.state?.diagnosis === "ready";
    }, 45_000, DEV_AUTH_TOKEN);

    const detail = await detailRes.json() as { state?: { diagnosis?: string }; diagnosisResult?: { summary?: { what_happened?: string } } };
    if (detail.state?.diagnosis !== "ready") {
      throw new Error(`Expected diagnosis ready, got ${detail.state?.diagnosis ?? "missing"}`);
    }
    console.log(`[cf-queue-local] incident ${incidentId} diagnosed: ${detail.diagnosisResult?.summary?.what_happened ?? "missing summary"}`);
  } finally {
    wrangler.kill("SIGTERM");
    await new Promise((resolve) => wrangler.once("exit", resolve));
    await new Promise<void>((resolve, reject) => mockServer.close((error) => error ? reject(error) : resolve()));
    restoreDevVars();
    rmSync(persistPath, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error("[cf-queue-local] validation failed:", error);
  process.exitCode = 1;
});
