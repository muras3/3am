import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiagnosisResult, IncidentPacket } from "@3amoncall/core";

// Mock @3amoncall/diagnosis BEFORE importing run
vi.mock("@3amoncall/diagnosis", () => ({
  diagnose: vi.fn(),
  PROVIDER_NAMES: ["anthropic", "openai", "ollama", "claude-code", "codex"],
}));

import { run } from "../index.js";
import { diagnose } from "@3amoncall/diagnosis";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validPacket: IncidentPacket = {
  schemaVersion: "incident-packet/v1alpha1",
  packetId: "pkt_test",
  incidentId: "inc_test",
  openedAt: "2026-03-09T00:00:00Z",
  window: {
    start: "2026-03-09T00:00:00Z",
    detect: "2026-03-09T00:01:00Z",
    end: "2026-03-09T00:05:00Z",
  },
  scope: {
    environment: "production",
    primaryService: "checkout-api",
    affectedServices: ["checkout-api"],
    affectedRoutes: ["/checkout"],
    affectedDependencies: ["stripe"],
  },
  triggerSignals: [
    { signal: "http_500", firstSeenAt: "2026-03-09T00:01:00Z", entity: "checkout-api" },
  ],
  evidence: {
    changedMetrics: [],
    representativeTraces: [
      {
        traceId: "t1",
        spanId: "s1",
        serviceName: "checkout-api",
        durationMs: 500,
        httpStatusCode: 500,
        spanStatusCode: 2,
      },
    ],
    relevantLogs: [],
    platformEvents: [],
  },
  pointers: {
    traceRefs: ["t1"],
    logRefs: [],
    metricRefs: [],
    platformLogRefs: [],
  },
};

const validDiagnosisResult: DiagnosisResult = {
  summary: {
    what_happened: "Stripe 429s caused checkout 504s.",
    root_cause_hypothesis: "Fixed retries amplified the failure.",
  },
  recommendation: {
    immediate_action: "Disable fixed retries.",
    action_rationale_short: "Fastest control point.",
    do_not: "Do not restart blindly.",
  },
  reasoning: {
    causal_chain: [
      { type: "external", title: "Stripe 429", detail: "rate limit begins" },
      { type: "system", title: "Retry loop", detail: "amplifies failure" },
      { type: "incident", title: "Queue climbs", detail: "local overload" },
      { type: "impact", title: "Checkout 504", detail: "customer-visible" },
    ],
  },
  operator_guidance: {
    watch_items: [{ label: "Queue", state: "must flatten first", status: "watch" }],
    operator_checks: ["Confirm queue depth flattens within 30s"],
  },
  confidence: {
    confidence_assessment: "High confidence.",
    uncertainty: "Stripe quota not visible in telemetry.",
  },
  metadata: {
    incident_id: "inc_test",
    packet_id: "pkt_test",
    model: "claude-sonnet-4-6",
    prompt_version: "v5",
    created_at: "2026-03-09T00:05:00Z",
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function writeTmpJson(filename: string, data: unknown): string {
  const filePath = join(tmpDir, filename);
  writeFileSync(filePath, JSON.stringify(data), "utf-8");
  return filePath;
}

// Capture stdout writes during run
function captureStdout(): { getOutput(): string; restore(): void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  return {
    getOutput() {
      return chunks.join("");
    },
    restore() {
      process.stdout.write = original;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CLI run()", () => {
  beforeEach(() => {
    tmpDir = join(tmpdir(), `cli-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    vi.mocked(diagnose).mockReset();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Test 1: valid packet → stdout contains DiagnosisResult JSON
  it("valid packet → writes DiagnosisResult JSON to stdout", async () => {
    vi.mocked(diagnose).mockResolvedValue(validDiagnosisResult);
    const packetPath = writeTmpJson("packet.json", validPacket);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called unexpectedly");
    }) as never);

    const capture = captureStdout();
    try {
      await run(["--packet", packetPath]);
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }

    const output = capture.getOutput();
    const parsed = JSON.parse(output) as DiagnosisResult;
    expect(parsed.summary.what_happened).toBe("Stripe 429s caused checkout 504s.");
    expect(parsed.metadata.incident_id).toBe("inc_test");
    expect(parsed.recommendation.immediate_action).toBe("Disable fixed retries.");
  });

  // Test 2: invalid packet JSON (wrong shape) → process.exit(1)
  it("invalid packet JSON shape → calls process.exit(1)", async () => {
    const invalidPacket = { schemaVersion: "incident-packet/v1alpha1", bad: "data" };
    const packetPath = writeTmpJson("bad-packet.json", invalidPacket);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      // do nothing, let the function return
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await run(["--packet", packetPath]);

    expect(exitSpy).toHaveBeenCalledWith(1);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // Test 3: callback success path — fetch is called with correct URL/headers/body
  it("--callback-url sends POST with correct headers and body", async () => {
    vi.mocked(diagnose).mockResolvedValue(validDiagnosisResult);
    const packetPath = writeTmpJson("packet.json", validPacket);

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as typeof fetch;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called unexpectedly");
    }) as never);

    const capture = captureStdout();
    try {
      await run([
        "--packet", packetPath,
        "--callback-url", "https://example.com/api/diagnosis/inc_test",
        "--callback-token", "my-secret-token",
      ]);
    } finally {
      capture.restore();
      exitSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/api/diagnosis/inc_test");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-secret-token");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string) as DiagnosisResult;
    expect(body.metadata.incident_id).toBe("inc_test");
  });

  // Test 4: callback failure (HTTP 400) → process.exit(1)
  it("callback HTTP 400 → calls process.exit(1)", async () => {
    vi.mocked(diagnose).mockResolvedValue(validDiagnosisResult);
    const packetPath = writeTmpJson("packet.json", validPacket);

    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as typeof fetch;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      // do nothing — allow run() to return so we can inspect call history
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await run([
        "--packet", packetPath,
        "--callback-url", "https://example.com/api/diagnosis/inc_test",
        "--callback-token", "my-secret-token",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Check before restoring so call history is intact
    expect(exitSpy).toHaveBeenCalledWith(1);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Callback retry tests
  // ---------------------------------------------------------------------------

  describe("callback retry", () => {
    let tmpDirRetry: string;

    beforeEach(() => {
      tmpDirRetry = join(tmpdir(), `cli-retry-test-${Date.now()}`);
      mkdirSync(tmpDirRetry, { recursive: true });
      vi.mocked(diagnose).mockReset();
      vi.useFakeTimers();
    });

    afterEach(() => {
      rmSync(tmpDirRetry, { recursive: true, force: true });
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it("retries callback on HTTP 429 then succeeds", async () => {
      vi.mocked(diagnose).mockResolvedValue(validDiagnosisResult);
      const packetPath = join(tmpDirRetry, "packet.json");
      writeFileSync(packetPath, JSON.stringify(validPacket), "utf-8");

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 429 })
        .mockResolvedValueOnce({ ok: false, status: 429 })
        .mockResolvedValueOnce({ ok: true, status: 200 });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as typeof fetch;

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called unexpectedly");
      }) as never);
      const capture = captureStdout();

      try {
        const promise = run(["--packet", packetPath, "--callback-url", "https://example.com/cb"]);
        await vi.advanceTimersByTimeAsync(1000); // first backoff
        await vi.advanceTimersByTimeAsync(2000); // second backoff
        await promise;
      } finally {
        capture.restore();
        exitSpy.mockRestore();
        globalThis.fetch = originalFetch;
      }

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("retries callback on network error then succeeds", async () => {
      vi.mocked(diagnose).mockResolvedValue(validDiagnosisResult);
      const packetPath = join(tmpDirRetry, "packet.json");
      writeFileSync(packetPath, JSON.stringify(validPacket), "utf-8");

      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce({ ok: true, status: 200 });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as typeof fetch;

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called unexpectedly");
      }) as never);
      const capture = captureStdout();

      try {
        const promise = run(["--packet", packetPath, "--callback-url", "https://example.com/cb"]);
        await vi.advanceTimersByTimeAsync(1000); // first backoff
        await promise;
      } finally {
        capture.restore();
        exitSpy.mockRestore();
        globalThis.fetch = originalFetch;
      }

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("does not retry callback on HTTP 400", async () => {
      vi.mocked(diagnose).mockResolvedValue(validDiagnosisResult);
      const packetPath = join(tmpDirRetry, "packet.json");
      writeFileSync(packetPath, JSON.stringify(validPacket), "utf-8");

      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 400 });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as typeof fetch;

      const exitMock = vi.fn();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(exitMock as never);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      try {
        const promise = run(["--packet", packetPath, "--callback-url", "https://example.com/cb"]);
        await promise;
      } finally {
        globalThis.fetch = originalFetch;
        stderrSpy.mockRestore();
        exitSpy.mockRestore();
      }

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(exitMock).toHaveBeenCalledWith(1);
    });

    it("exits 1 after all callback retries exhausted", async () => {
      vi.mocked(diagnose).mockResolvedValue(validDiagnosisResult);
      const packetPath = join(tmpDirRetry, "packet.json");
      writeFileSync(packetPath, JSON.stringify(validPacket), "utf-8");

      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as typeof fetch;

      const exitMock = vi.fn();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(exitMock as never);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      try {
        const promise = run(["--packet", packetPath, "--callback-url", "https://example.com/cb"]);
        await vi.advanceTimersByTimeAsync(1000); // first backoff
        await vi.advanceTimersByTimeAsync(2000); // second backoff
        await promise;
      } finally {
        globalThis.fetch = originalFetch;
        stderrSpy.mockRestore();
        exitSpy.mockRestore();
      }

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(exitMock).toHaveBeenCalledWith(1);
    });
  });

  // Test 5: missing --packet flag → process.exit(1)
  it("missing --packet flag → calls process.exit(1)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      // do nothing
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await run([]);

    expect(exitSpy).toHaveBeenCalledWith(1);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
