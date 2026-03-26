import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:child_process — must be at top level for hoisting
// ---------------------------------------------------------------------------
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock node:readline — must be at top level for ESM hoisting
// ---------------------------------------------------------------------------
const mockRlInstance = {
  question: vi.fn(),
  close: vi.fn(),
};

vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => mockRlInstance),
}));

import { execFileSync, execFile } from "node:child_process";
import {
  detectPlatformCli,
  checkPlatformAuth,
  promptPlatformSelection,
} from "../commands/deploy/platform.js";

// ---------------------------------------------------------------------------
// detectPlatformCli
// ---------------------------------------------------------------------------

describe("detectPlatformCli()", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("returns true when the CLI binary is found", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from("/usr/local/bin/vercel"));
    expect(detectPlatformCli("vercel")).toBe(true);
  });

  it("returns false when the CLI binary is not found (execFileSync throws)", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("not found");
    });
    expect(detectPlatformCli("cloudflare")).toBe(false);
  });

  it("invokes which with 'vercel' binary for vercel platform", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    detectPlatformCli("vercel");
    expect(execFileSync).toHaveBeenCalledWith("which", ["vercel"], {
      stdio: "ignore",
    });
  });

  it("invokes which with 'wrangler' binary for cloudflare platform", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    detectPlatformCli("cloudflare");
    expect(execFileSync).toHaveBeenCalledWith("which", ["wrangler"], {
      stdio: "ignore",
    });
  });
});

// ---------------------------------------------------------------------------
// checkPlatformAuth
//
// checkPlatformAuth uses promisify(execFile) internally. The mock for
// execFile must accept a callback as the last argument (after optional opts)
// since that is how promisify wraps it.
// ---------------------------------------------------------------------------

describe("checkPlatformAuth()", () => {
  beforeEach(() => {
    vi.mocked(execFile).mockReset();
  });

  it("returns true when whoami exits with code 0", async () => {
    vi.mocked(execFile).mockImplementation(
      // execFile(file, args, options, callback) — promisify passes cb as last arg
      (...args: unknown[]) => {
        const cb = args[args.length - 1] as (
          err: null,
          stdout: string,
          stderr: string,
        ) => void;
        cb(null, "username@example.com", "");
        return undefined as unknown as ReturnType<typeof execFile>;
      },
    );
    expect(await checkPlatformAuth("vercel")).toBe(true);
  });

  it("returns false when whoami fails (non-zero exit)", async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error) => void;
      cb(Object.assign(new Error("not logged in"), { code: 1 }));
      return undefined as unknown as ReturnType<typeof execFile>;
    });
    expect(await checkPlatformAuth("cloudflare")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// promptPlatformSelection
// ---------------------------------------------------------------------------

describe("promptPlatformSelection()", () => {
  let stdoutChunks: string[];

  beforeEach(() => {
    stdoutChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    mockRlInstance.question.mockReset();
    mockRlInstance.close.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'vercel' when user inputs '1'", async () => {
    mockRlInstance.question.mockImplementationOnce(
      (_prompt: string, cb: (answer: string) => void) => {
        cb("1");
      },
    );

    const result = await promptPlatformSelection();
    expect(result).toBe("vercel");
    expect(mockRlInstance.close).toHaveBeenCalled();
  });

  it("returns 'cloudflare' when user inputs '2'", async () => {
    mockRlInstance.question.mockImplementationOnce(
      (_prompt: string, cb: (answer: string) => void) => {
        cb("2");
      },
    );

    const result = await promptPlatformSelection();
    expect(result).toBe("cloudflare");
    expect(mockRlInstance.close).toHaveBeenCalled();
  });

  it("re-prompts on invalid input and resolves on subsequent valid input", async () => {
    mockRlInstance.question
      .mockImplementationOnce((_prompt: string, cb: (answer: string) => void) => {
        cb("x");
      })
      .mockImplementationOnce((_prompt: string, cb: (answer: string) => void) => {
        cb("1");
      });

    const result = await promptPlatformSelection();
    expect(result).toBe("vercel");
    expect(mockRlInstance.question).toHaveBeenCalledTimes(2);
    expect(stdoutChunks.join("")).toContain("Invalid selection");
  });
});
