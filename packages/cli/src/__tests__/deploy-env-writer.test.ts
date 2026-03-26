import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updateAppEnv } from "../commands/deploy/env-writer.js";

// ---------------------------------------------------------------------------
// readline mock (module-level, required for ESM)
// ---------------------------------------------------------------------------

// Mock state shared between tests
let _mockRlQuestion: ((prompt: string, cb: (answer: string) => void) => void) | null = null;
let _mockRlClose: (() => void) | null = null;

vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    question: (prompt: string, cb: (answer: string) => void) => {
      if (_mockRlQuestion) {
        _mockRlQuestion(prompt, cb);
      } else {
        cb("");
      }
    },
    close: () => {
      if (_mockRlClose) _mockRlClose();
    },
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "env-writer-test-"));
}

// ---------------------------------------------------------------------------
// updateAppEnv
// ---------------------------------------------------------------------------

describe("updateAppEnv()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Empty .env file → both keys added
  it("adds both keys to an empty .env file", () => {
    const envPath = join(tmpDir, ".env");
    writeFileSync(envPath, "", "utf-8");

    const result = updateAppEnv({
      receiverUrl: "https://receiver.example.com",
      authToken: "tok_abc123",
      envPath,
    });

    expect(result.added).toEqual([
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
    ]);
    expect(result.updated).toEqual([]);
    expect(result.envPath).toBe(envPath);

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain(
      "OTEL_EXPORTER_OTLP_ENDPOINT=https://receiver.example.com",
    );
    expect(content).toContain(
      "OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer tok_abc123",
    );
  });

  // 2. .env with unrelated vars → OTEL keys appended, existing vars preserved
  it("appends OTEL keys without disturbing existing vars", () => {
    const envPath = join(tmpDir, ".env");
    writeFileSync(envPath, "FOO=bar\nBAZ=qux\n", "utf-8");

    const result = updateAppEnv({
      receiverUrl: "https://receiver.example.com",
      authToken: "tok_abc123",
      envPath,
    });

    expect(result.added).toEqual([
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
    ]);
    expect(result.updated).toEqual([]);

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("FOO=bar");
    expect(content).toContain("BAZ=qux");
    expect(content).toContain(
      "OTEL_EXPORTER_OTLP_ENDPOINT=https://receiver.example.com",
    );
    expect(content).toContain(
      "OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer tok_abc123",
    );
  });

  // 3. .env with existing OTEL keys (different values) → updated in place
  it("updates existing OTEL keys with different values", () => {
    const envPath = join(tmpDir, ".env");
    writeFileSync(
      envPath,
      [
        "OTEL_EXPORTER_OTLP_ENDPOINT=https://old.example.com",
        "OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer old_token",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = updateAppEnv({
      receiverUrl: "https://new.example.com",
      authToken: "new_token",
      envPath,
    });

    expect(result.added).toEqual([]);
    expect(result.updated).toEqual([
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
    ]);

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain(
      "OTEL_EXPORTER_OTLP_ENDPOINT=https://new.example.com",
    );
    expect(content).toContain(
      "OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer new_token",
    );
    // Old values gone
    expect(content).not.toContain("old.example.com");
    expect(content).not.toContain("old_token");
  });

  // 4. .env with existing OTEL keys (same values) → no changes
  it("leaves file unchanged when OTEL keys already have the correct values", () => {
    const endpoint = "https://receiver.example.com";
    const headers = "Authorization=Bearer tok_abc123";
    const envPath = join(tmpDir, ".env");
    writeFileSync(
      envPath,
      [
        `OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`,
        `OTEL_EXPORTER_OTLP_HEADERS=${headers}`,
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = updateAppEnv({
      receiverUrl: endpoint,
      authToken: "tok_abc123",
      envPath,
    });

    expect(result.added).toEqual([]);
    expect(result.updated).toEqual([]);
  });

  // 5. dryRun: true → returns changes but file content unchanged
  it("dryRun: returns changes without writing the file", () => {
    const envPath = join(tmpDir, ".env");
    const original = "FOO=bar\n";
    writeFileSync(envPath, original, "utf-8");

    const result = updateAppEnv({
      receiverUrl: "https://receiver.example.com",
      authToken: "tok_abc123",
      envPath,
      dryRun: true,
    });

    expect(result.added).toEqual([
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
    ]);
    expect(result.updated).toEqual([]);

    // File must be unchanged
    const content = readFileSync(envPath, "utf-8");
    expect(content).toBe(original);
  });

  // 6. No .env file → file created with both keys
  it("creates .env file when it does not exist", () => {
    const envPath = join(tmpDir, ".env");
    // Do NOT create the file

    const result = updateAppEnv({
      receiverUrl: "https://receiver.example.com",
      authToken: "tok_abc123",
      envPath,
    });

    expect(result.added).toEqual([
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
    ]);
    expect(result.updated).toEqual([]);

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain(
      "OTEL_EXPORTER_OTLP_ENDPOINT=https://receiver.example.com",
    );
    expect(content).toContain(
      "OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer tok_abc123",
    );
  });

  // 7. .env with comments → comments preserved
  it("preserves comments and blank lines", () => {
    const envPath = join(tmpDir, ".env");
    writeFileSync(
      envPath,
      "# My config\nFOO=bar\n\n# Another comment\n",
      "utf-8",
    );

    updateAppEnv({
      receiverUrl: "https://receiver.example.com",
      authToken: "tok_abc123",
      envPath,
    });

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("# My config");
    expect(content).toContain("FOO=bar");
    expect(content).toContain("# Another comment");
  });

  // 8. receiverUrl without https:// → auto-prepended
  it("prepends https:// when receiverUrl has no scheme", () => {
    const envPath = join(tmpDir, ".env");
    writeFileSync(envPath, "", "utf-8");

    updateAppEnv({
      receiverUrl: "receiver.example.com",
      authToken: "tok_abc123",
      envPath,
    });

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain(
      "OTEL_EXPORTER_OTLP_ENDPOINT=https://receiver.example.com",
    );
  });

  // Additional: http:// prefix should be left as-is (not double-prefixed)
  it("does not double-prefix a URL that already has https://", () => {
    const envPath = join(tmpDir, ".env");
    writeFileSync(envPath, "", "utf-8");

    updateAppEnv({
      receiverUrl: "https://already.example.com",
      authToken: "tok",
      envPath,
    });

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain(
      "OTEL_EXPORTER_OTLP_ENDPOINT=https://already.example.com",
    );
    expect(content).not.toContain("https://https://");
  });
});

// ---------------------------------------------------------------------------
// promptAuthToken
// ---------------------------------------------------------------------------

describe("promptAuthToken()", () => {
  // Import the function directly — the vi.mock above is hoisted so it's
  // already in place when this module is evaluated.
  let promptAuthTokenFn: () => Promise<string>;

  beforeEach(async () => {
    _mockRlQuestion = null;
    _mockRlClose = null;
    const mod = await import("../commands/deploy/env-writer.js");
    promptAuthTokenFn = mod.promptAuthToken;
  });

  afterEach(() => {
    _mockRlQuestion = null;
    _mockRlClose = null;
  });

  // 9. Valid input → returns trimmed token
  it("returns the trimmed token when user provides valid input", async () => {
    _mockRlQuestion = (_prompt, cb) => {
      cb("  my-secret-token  ");
    };

    const token = await promptAuthTokenFn();
    expect(token).toBe("my-secret-token");
  });

  // 10. Empty input → re-prompts (mock readline to return empty then valid)
  it("re-prompts when the user submits an empty string", async () => {
    let callCount = 0;
    _mockRlQuestion = (_prompt, cb) => {
      callCount += 1;
      if (callCount === 1) {
        cb("   "); // empty after trim — should re-prompt
      } else {
        cb("real-token");
      }
    };

    const token = await promptAuthTokenFn();
    expect(token).toBe("real-token");
    expect(callCount).toBe(2);
  });
});
