/**
 * bridge-cold-start.test.ts — Verifies that the bridge waits for the Claude Code
 * pool to finish priming before dispatching LLM work from poll/WS jobs.
 *
 * This is in a separate file because the vi.mock() calls for
 * `3am-diagnosis/claude-code-pool` and `manual-execution.js` are hoisted to the
 * top level and would interfere with other bridge tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Controllable mock state ──────────────────────────────────────────────────
// vi.hoisted() runs before module imports, giving us stable references that
// both the mock factories and the test bodies can share.

const { timeline, primeControl, runManualEvidenceQueryMock } = vi.hoisted(() => {
  const timeline: string[] = [];
  let resolvePrime: (() => void) | null = null;
  const primeControl = {
    get resolve() { return resolvePrime; },
    set resolve(fn: (() => void) | null) { resolvePrime = fn; },
    /** Reset for the next test */
    reset() {
      resolvePrime = null;
      timeline.length = 0;
    },
  };
  const runManualEvidenceQueryMock = vi.fn();
  return { timeline, primeControl, runManualEvidenceQueryMock };
});

// ── Module mocks (hoisted to top level) ──────────────────────────────────────

vi.mock("3am-diagnosis/claude-code-pool", () => ({
  prime: () => {
    timeline.push("prime:start");
    return new Promise<void>((resolve) => {
      // If a test has already set the resolve, call it immediately.
      // Otherwise, store it for the test to call later.
      if (primeControl.resolve) {
        resolve();
        timeline.push("prime:done");
      } else {
        primeControl.resolve = () => {
          timeline.push("prime:done");
          resolve();
        };
      }
    });
  },
  shutdown: vi.fn(),
}));

vi.mock("../commands/manual-execution.js", () => ({
  runManualEvidenceQuery: runManualEvidenceQueryMock,
  runManualChat: vi.fn(),
  runManualDiagnosis: vi.fn(),
}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runBridge pool priming gate", () => {
  let homeDir: string;
  let originalHome: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "threeam-bridge-coldstart-"));
    originalHome = process.env["HOME"];
    process.env["HOME"] = homeDir;
    originalFetch = globalThis.fetch;
    primeControl.reset();

    runManualEvidenceQueryMock.mockImplementation(async () => {
      timeline.push("llm:dispatch");
      return {
        question: "What happened?",
        status: "answered",
        segments: [{ id: "seg-1", kind: "fact", text: "Answer.", evidenceRefs: [] }],
      };
    });
  });

  afterEach(() => {
    process.env["HOME"] = originalHome;
    rmSync(homeDir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("waits for pool prime to finish before dispatching LLM work from poll jobs", async () => {
    // Dynamic import to get a fresh runBridge with our mocked modules
    const { runBridge } = await import("../commands/bridge.js");
    const port = 5570 + Math.floor(Math.random() * 1000);

    // Mock fetch: first poll returns a job, subsequent polls return null
    let jobReturned = false;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (typeof url === "string" && url.includes("/api/bridge/jobs") && opts?.method === "GET") {
        if (!jobReturned) {
          jobReturned = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              job: {
                jobId: "test-job-1",
                request: {
                  type: "evidence_query_request",
                  id: "test-job-1",
                  receiverUrl: "https://receiver-example.vercel.app",
                  incidentId: "inc_test",
                  question: "What happened?",
                  history: [],
                  provider: "claude-code",
                  locale: "en",
                  isSystemFollowup: false,
                },
              },
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ job: null }) };
      }
      if (typeof url === "string" && url.includes("/api/bridge/results/")) {
        timeline.push("result:posted");
        return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as typeof fetch;

    const bridge = runBridge({
      port,
      receiverUrl: "https://receiver-example.vercel.app",
      registerSignalHandlers: false,
    });

    try {
      // Wait for the initial poll to pick up the job — but prime is NOT resolved yet
      await new Promise((r) => setTimeout(r, 100));

      // Prime should have started
      expect(timeline).toContain("prime:start");
      // LLM dispatch should NOT have happened yet (blocked by poolReadyPromise)
      expect(timeline).not.toContain("llm:dispatch");

      // Now resolve the prime promise — this should unblock LLM dispatch
      primeControl.resolve!();
      await new Promise((r) => setTimeout(r, 100));

      // LLM dispatch should have happened AFTER prime completed
      expect(timeline).toContain("prime:done");
      expect(timeline).toContain("llm:dispatch");

      // Verify ordering: prime:done must come before llm:dispatch
      const primeDoneIndex = timeline.indexOf("prime:done");
      const llmDispatchIndex = timeline.indexOf("llm:dispatch");
      expect(primeDoneIndex).toBeLessThan(llmDispatchIndex);
    } finally {
      bridge.close();
    }
  });

  it("dispatches immediately when provider is not claude-code (no pool prime needed)", async () => {
    const { runBridge } = await import("../commands/bridge.js");
    const port = 5670 + Math.floor(Math.random() * 1000);

    // Write credentials with a non-claude-code provider so prime is skipped
    mkdirSync(join(homeDir, ".config", "3am"), { recursive: true });
    writeFileSync(
      join(homeDir, ".config", "3am", "credentials"),
      JSON.stringify({
        llmProvider: "anthropic",
        receiverUrl: "https://receiver-example.vercel.app",
      }),
    );

    // Set resolve immediately so if prime is accidentally called, it won't block
    primeControl.resolve = () => { timeline.push("prime:done"); };

    let jobReturned = false;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (typeof url === "string" && url.includes("/api/bridge/jobs") && opts?.method === "GET") {
        if (!jobReturned) {
          jobReturned = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              job: {
                jobId: "test-job-2",
                request: {
                  type: "evidence_query_request",
                  id: "test-job-2",
                  receiverUrl: "https://receiver-example.vercel.app",
                  incidentId: "inc_test",
                  question: "What happened?",
                  history: [],
                  provider: "anthropic",
                  locale: "en",
                  isSystemFollowup: false,
                },
              },
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ job: null }) };
      }
      if (typeof url === "string" && url.includes("/api/bridge/results/")) {
        return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as typeof fetch;

    const bridge = runBridge({
      port,
      receiverUrl: "https://receiver-example.vercel.app",
      registerSignalHandlers: false,
    });

    try {
      await new Promise((r) => setTimeout(r, 150));

      // Prime should NOT have been called (provider is anthropic, not claude-code)
      expect(timeline).not.toContain("prime:start");
      // LLM dispatch should have happened immediately without waiting
      expect(timeline).toContain("llm:dispatch");
    } finally {
      bridge.close();
    }
  });
});
