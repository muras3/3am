import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const { mockCallModelMessages, mockDiagnose, mockGenerateConsoleNarrative } = vi.hoisted(() => ({
  mockCallModelMessages: vi.fn(),
  mockDiagnose: vi.fn(),
  mockGenerateConsoleNarrative: vi.fn(),
}));

vi.mock("3am-diagnosis", async () => {
  const actual = await vi.importActual("3am-diagnosis");
  return {
    ...actual,
    callModelMessages: mockCallModelMessages,
    diagnose: mockDiagnose,
    generateConsoleNarrative: mockGenerateConsoleNarrative,
  };
});

vi.mock("../commands/provider-model.js", () => ({
  resolveProviderModel: vi.fn((_provider, model) => model ?? "test-model"),
}));

import { runManualChat, runManualDiagnosis } from "../commands/manual-execution.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_PACKET = {
  metadata: { packet_id: "pkt_001" },
  summary: { what_happened: "test" },
} as never;

const FAKE_REASONING = {
  incidentId: "inc_001",
  proofRefs: [],
} as never;

const FAKE_DIAGNOSIS = {
  metadata: { packet_id: "pkt_001" },
  summary: { what_happened: "test", root_cause_hypothesis: "test" },
  recommendation: { immediate_action: "test" },
  reasoning: { causal_chain: [] },
  confidence: { confidence_assessment: "high", uncertainty: "none" },
} as never;

const FAKE_NARRATIVE = {
  headline: "Test narrative",
  qa: { answerEvidenceRefs: [], evidenceBindings: [] },
} as never;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sets up globalThis.fetch to respond to the known API paths that
 * runManualDiagnosis calls.  Returns a spy so tests can inspect calls.
 */
function setupFetchMock(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    // GET packet
    if (urlStr.includes("/packet") && (!init || init.method === undefined || init.method === "GET")) {
      return new Response(JSON.stringify(FAKE_PACKET), { status: 200 });
    }
    // GET reasoning-structure
    if (urlStr.includes("/reasoning-structure")) {
      return new Response(JSON.stringify(FAKE_REASONING), { status: 200 });
    }
    // GET locale
    if (urlStr.includes("/settings/locale")) {
      return new Response(JSON.stringify({ locale: "en" }), { status: 200 });
    }
    // POST diagnosis callback
    if (urlStr.includes("/api/diagnosis/") && init?.method === "POST") {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    // POST narrative callback
    if (urlStr.includes("/console-narrative") && init?.method === "POST") {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ---------------------------------------------------------------------------
// Tests — runManualDiagnosis (graceful degradation)
// ---------------------------------------------------------------------------

describe("runManualDiagnosis", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = setupFetchMock();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockDiagnose.mockResolvedValue(FAKE_DIAGNOSIS);
    mockGenerateConsoleNarrative.mockResolvedValue(FAKE_NARRATIVE);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    warnSpy.mockRestore();
  });

  it("returns diagnosis and narrative on success", async () => {
    const result = await runManualDiagnosis({
      receiverUrl: "http://localhost:3333",
      incidentId: "inc_000001",
      provider: "codex",
    });

    expect(result.diagnosis).toBe(FAKE_DIAGNOSIS);
    expect(result.narrative).toBe(FAKE_NARRATIVE);
  });

  it("returns stage 1 diagnosis when stage 2 narrative generation throws", async () => {
    mockGenerateConsoleNarrative.mockRejectedValue(
      new Error("NarrativeValidationError: evidence ref 'invented_id' not in proofRefs"),
    );

    const result = await runManualDiagnosis({
      receiverUrl: "http://localhost:3333",
      incidentId: "inc_000001",
      provider: "codex",
    });

    // Stage 1 result must still be returned
    expect(result.diagnosis).toBe(FAKE_DIAGNOSIS);
    // Narrative should be undefined, not throw
    expect(result.narrative).toBeUndefined();
  });

  it("emits a warning (not an error) when narrative generation fails", async () => {
    mockGenerateConsoleNarrative.mockRejectedValue(
      new Error("NarrativeValidationError: bad refs"),
    );

    await runManualDiagnosis({
      receiverUrl: "http://localhost:3333",
      incidentId: "inc_000001",
      provider: "codex",
    });

    const warnCalls = warnSpy.mock.calls.map((args) => String(args[0]));
    expect(warnCalls.some((msg) => msg.includes("narrative generation failed"))).toBe(true);
    expect(warnCalls.some((msg) => msg.includes("stage 1 result preserved"))).toBe(true);
  });

  it("still POSTs diagnosis to receiver callback when narrative fails", async () => {
    mockGenerateConsoleNarrative.mockRejectedValue(
      new Error("NarrativeValidationError: invented evidence"),
    );

    await runManualDiagnosis({
      receiverUrl: "http://localhost:3333",
      incidentId: "inc_000001",
      provider: "codex",
    });

    // Find the POST to /api/diagnosis/
    const diagnosisPost = fetchMock.mock.calls.find(
      ([url, init]: [string, RequestInit | undefined]) =>
        String(url).includes("/api/diagnosis/") && init?.method === "POST",
    );
    expect(diagnosisPost).toBeDefined();
    const postedBody = JSON.parse(diagnosisPost![1].body as string);
    expect(postedBody).toEqual(FAKE_DIAGNOSIS);
  });

  it("does NOT POST narrative to receiver when narrative generation failed", async () => {
    mockGenerateConsoleNarrative.mockRejectedValue(
      new Error("NarrativeValidationError: bad"),
    );

    await runManualDiagnosis({
      receiverUrl: "http://localhost:3333",
      incidentId: "inc_000001",
      provider: "codex",
    });

    // Should NOT have a POST to /console-narrative
    const narrativePost = fetchMock.mock.calls.find(
      ([url, init]: [string, RequestInit | undefined]) =>
        String(url).includes("/console-narrative") && init?.method === "POST",
    );
    expect(narrativePost).toBeUndefined();
  });

  it("POSTs narrative to receiver when narrative generation succeeds", async () => {
    await runManualDiagnosis({
      receiverUrl: "http://localhost:3333",
      incidentId: "inc_000001",
      provider: "codex",
    });

    const narrativePost = fetchMock.mock.calls.find(
      ([url, init]: [string, RequestInit | undefined]) =>
        String(url).includes("/console-narrative") && init?.method === "POST",
    );
    expect(narrativePost).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests — runManualChat
// ---------------------------------------------------------------------------

describe("runManualChat", () => {
  beforeEach(() => {
    mockCallModelMessages.mockReset();
    mockCallModelMessages.mockResolvedValue("ok");
  });

  it("wraps the user message exactly once before calling the model", async () => {
    await runManualChat({
      receiverUrl: "http://localhost:3333",
      incidentId: "inc_000001",
      message: "What happened?",
      history: [],
      provider: "codex",
      systemPrompt: "system prompt",
    });

    const messages = mockCallModelMessages.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "<user_message>What happened?</user_message>" },
    ]);
  });
});
