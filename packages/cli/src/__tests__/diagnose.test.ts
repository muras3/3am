import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

vi.mock("3am-core", () => ({
  IncidentPacketSchema: {
    safeParse: vi.fn(),
  },
}));

vi.mock("../commands/init/credentials.js", () => ({
  loadCredentials: vi.fn(),
  findReceiverCredentialByUrl: vi.fn((creds, url) =>
    Object.values(creds.receivers ?? {}).find((receiver) => receiver?.url === url),
  ),
}));

vi.mock("../commands/manual-execution.js", () => ({
  runManualDiagnosis: vi.fn(),
}));

vi.mock("3am-diagnosis", () => ({
  PROVIDER_NAMES: ["anthropic", "codex"],
  diagnose: vi.fn(),
}));

vi.mock("../commands/provider-model.js", () => ({
  resolveProviderModel: vi.fn((_provider, model, fallback) => model ?? fallback),
}));

import { loadCredentials } from "../commands/init/credentials.js";
import { runManualDiagnosis } from "../commands/manual-execution.js";
import { runDiagnose } from "../commands/diagnose.js";

describe("runDiagnose()", () => {
  let stdoutChunks: string[];
  let stderrChunks: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutChunks = [];
    stderrChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses receiver URL and auth token from credentials for manual diagnosis", async () => {
    vi.mocked(loadCredentials).mockReturnValue({
      receiverUrl: "https://3am-receiver.vercel.app",
      receiverAuthToken: "stored-token",
      llmProvider: "codex",
      llmModel: "gpt-5.1",
      locale: "ja",
    });
    vi.mocked(runManualDiagnosis).mockResolvedValue({
      diagnosis: { id: "diag_123" },
      narrative: { title: "narrative" },
    } as never);

    await runDiagnose(["--incident-id", "inc_000001"]);

    expect(runManualDiagnosis).toHaveBeenCalledWith({
      incidentId: "inc_000001",
      receiverUrl: "https://3am-receiver.vercel.app",
      authToken: "stored-token",
      provider: "codex",
      model: "gpt-5.1",
      locale: "ja",
    });
    expect(process.exit).not.toHaveBeenCalled();
    expect(stdoutChunks.join("")).toContain('"diagnosis"');
  });

  it("prefers explicit manual diagnosis flags over stored credentials", async () => {
    vi.mocked(loadCredentials).mockReturnValue({
      receiverUrl: "https://stored.vercel.app",
      receiverAuthToken: "stored-token",
    });
    vi.mocked(runManualDiagnosis).mockResolvedValue({
      diagnosis: { id: "diag_123" },
      narrative: { title: "narrative" },
    } as never);

    await runDiagnose([
      "--incident-id",
      "inc_000001",
      "--receiver-url",
      "https://explicit.vercel.app",
      "--auth-token",
      "explicit-token",
    ]);

    expect(runManualDiagnosis).toHaveBeenCalledWith(
      expect.objectContaining({
        receiverUrl: "https://explicit.vercel.app",
        authToken: "explicit-token",
      }),
    );
  });

  it("matches the auth token to the explicit receiver URL from platform-scoped credentials", async () => {
    vi.mocked(loadCredentials).mockReturnValue({
      receiverUrl: "https://3am-receiver.vercel.app",
      receiverAuthToken: "vercel-token",
      receivers: {
        vercel: {
          url: "https://3am-receiver.vercel.app",
          authToken: "vercel-token",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
        cloudflare: {
          url: "https://3amoncall.workers.dev",
          authToken: "cloudflare-token",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      },
    });
    vi.mocked(runManualDiagnosis).mockResolvedValue({
      diagnosis: { id: "diag_123" },
      narrative: { title: "narrative" },
    } as never);

    await runDiagnose([
      "--incident-id",
      "inc_000001",
      "--receiver-url",
      "https://3amoncall.workers.dev",
    ]);

    expect(runManualDiagnosis).toHaveBeenCalledWith(
      expect.objectContaining({
        receiverUrl: "https://3amoncall.workers.dev",
        authToken: "cloudflare-token",
      }),
    );
  });

  it("fails with a targeted error when incident mode has no receiver URL", async () => {
    vi.mocked(loadCredentials).mockReturnValue({});

    await runDiagnose(["--incident-id", "inc_000001"]);

    expect(runManualDiagnosis).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderrChunks.join("")).toContain("--incident-id requires --receiver-url");
  });
});
