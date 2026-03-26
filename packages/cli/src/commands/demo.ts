/**
 * `npx 3amoncall demo` — inject a demo incident and run real LLM diagnosis.
 *
 * Sends a synthetic downstream-timeout trace to the local Receiver,
 * waits for the diagnosis pipeline to complete, and guides the user
 * to the Console to inspect the result and try the AI copilot.
 *
 * - service.name = "3amoncall-demo"
 * - deployment.environment.name = "demo"
 * - Real LLM diagnosis (ANTHROPIC_API_KEY required)
 * - Local/dev only
 */
import { createInterface } from "node:readline";
import { resolveApiKey } from "./init/credentials.js";
import { checkReceiver } from "./shared/health.js";

const DEFAULT_RECEIVER_URL = "http://localhost:3333";
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 120_000;

export interface DemoOptions {
  yes?: boolean;
  noInteractive?: boolean;
  receiverUrl?: string;
}

function randomHex(length: number): string {
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * 16)];
  }
  return result;
}

/**
 * Build OTLP JSON payload for the downstream timeout cascade demo.
 *
 * Scenario: POST /checkout takes 8.2s and returns 504.
 * A child span shows the notification-service call timing out at 8.1s.
 *
 * Both spans trigger anomaly detection (status >= 500, duration > 5000ms).
 */
export function buildDemoPayload(): object {
  const now = BigInt(Date.now()) * 1_000_000n;
  const traceId = randomHex(32);
  const rootSpanId = randomHex(16);
  const childSpanId = randomHex(16);

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "3amoncall-demo" } },
            {
              key: "deployment.environment.name",
              value: { stringValue: "demo" },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId: rootSpanId,
                name: "POST /checkout",
                startTimeUnixNano: String(now - 8_200_000_000n),
                endTimeUnixNano: String(now),
                status: { code: 2 },
                attributes: [
                  {
                    key: "http.route",
                    value: { stringValue: "/checkout" },
                  },
                  {
                    key: "http.response.status_code",
                    value: { intValue: 504 },
                  },
                ],
              },
              {
                traceId,
                spanId: childSpanId,
                parentSpanId: rootSpanId,
                name: "POST /api/notifications",
                startTimeUnixNano: String(now - 8_100_000_000n),
                endTimeUnixNano: String(now - 100_000_000n),
                status: { code: 2 },
                attributes: [
                  {
                    key: "http.route",
                    value: { stringValue: "/api/notifications" },
                  },
                  {
                    key: "http.response.status_code",
                    value: { intValue: 504 },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

async function promptConfirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "" || a === "y" || a === "yes");
    });
  });
}

function createSpinner(message: string): {
  stop: (finalMessage: string) => void;
} {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r${frames[i++ % frames.length]} ${message}`);
  }, 80);
  return {
    stop(finalMessage: string) {
      clearInterval(interval);
      process.stdout.write(`\r${finalMessage}\n`);
    },
  };
}

async function pollDiagnosis(
  baseUrl: string,
  incidentId: string,
): Promise<boolean> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/incidents/${incidentId}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          diagnosisResult?: unknown;
          headline?: string;
        };
        // buildExtendedIncident flattens diagnosisResult into headline/action/etc.
        // Check both raw and extended shapes.
        if (data.diagnosisResult || data.headline) return true;
      }
    } catch {
      // retry on network errors
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

export async function runDemo(
  _argv: string[],
  options: DemoOptions = {},
): Promise<void> {
  const baseUrl = options.receiverUrl ?? DEFAULT_RECEIVER_URL;

  // 1. Resolve API key (required for demo — real LLM diagnosis)
  const apiKey = await resolveApiKey({
    noInteractive: options.noInteractive,
  });

  if (!apiKey) {
    process.stderr.write(
      "Error: ANTHROPIC_API_KEY is required to run the demo.\n" +
        "The demo runs a real LLM diagnosis — an API key must be configured.\n\n" +
        "Fix:\n" +
        "  npx 3amoncall init --api-key <your-key>\n" +
        "  npx 3amoncall demo\n",
    );
    process.exit(1);
    return;
  }

  // 2. Check Receiver is running
  process.stdout.write(`Checking Receiver at ${baseUrl}...\n`);
  const receiverUp = await checkReceiver(baseUrl);
  if (!receiverUp) {
    process.stderr.write(
      `Error: Receiver is not running at ${baseUrl}.\n\n` +
        "Start it first:\n" +
        "  npx 3amoncall dev\n\n" +
        "Then in another terminal:\n" +
        "  npx 3amoncall demo\n",
    );
    process.exit(1);
    return;
  }

  // 3. Cost consent
  process.stdout.write("\n");
  process.stdout.write("  scenario:    downstream timeout cascade\n");
  process.stdout.write("  service:     3amoncall-demo\n");
  process.stdout.write("  environment: demo\n\n");

  if (!options.yes) {
    process.stdout.write(
      "This demo will use your ANTHROPIC_API_KEY to run a real LLM diagnosis.\n" +
        "Estimated cost: ~¥10 (~$0.05) per run.\n\n",
    );
    if (options.noInteractive) {
      process.stderr.write(
        "Error: cost consent required. Use --yes to skip in non-interactive mode.\n",
      );
      process.exit(1);
      return;
    }
    const confirmed = await promptConfirm("Proceed? [Y/n] ");
    if (!confirmed) {
      process.stdout.write("Demo cancelled.\n");
      return;
    }
  }

  // 4. Send demo traces
  process.stdout.write("\nSending demo incident...\n");
  const payload = buildDemoPayload();

  let incidentId: string;
  try {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text}`);
    }
    const data = (await res.json()) as {
      status: string;
      incidentId?: string;
    };
    if (!data.incidentId) {
      throw new Error(
        "Receiver did not create an incident. Response: " +
          JSON.stringify(data),
      );
    }
    incidentId = data.incidentId;
  } catch (err) {
    process.stderr.write(
      `Error: failed to send demo traces: ${String(err)}\n`,
    );
    process.exit(1);
    return;
  }

  process.stdout.write(`✓ Incident created (${incidentId})\n`);

  // 5. Poll for diagnosis completion
  const spinner = createSpinner("Running LLM diagnosis... (15-30s)");
  const diagnosed = await pollDiagnosis(baseUrl, incidentId);

  if (diagnosed) {
    spinner.stop("✓ Diagnosis complete!");
  } else {
    spinner.stop("⏳ Diagnosis is taking longer than expected.");
    process.stdout.write(
      "  The Receiver may still be running the diagnosis.\n" +
        "  Check the Console in a moment.\n" +
        "  If diagnosis doesn't appear, make sure the Receiver was started\n" +
        "  with ANTHROPIC_API_KEY (re-run `npx 3amoncall dev`).\n",
    );
  }

  // 6. Next steps
  process.stdout.write("\nNext steps:\n");
  process.stdout.write(`  1. Open ${baseUrl}\n`);
  process.stdout.write("  2. Click the demo incident to see the diagnosis\n");
  process.stdout.write(
    '  3. Try asking the AI copilot: "Why did /checkout fail?"\n',
  );
  process.stdout.write("     (Each question costs ~¥5)\n\n");
  process.stdout.write(
    "This is demo data — it won't appear in production.\n",
  );
}
