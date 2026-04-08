import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolveVercelProductionUrl } from "../commands/deploy/provider.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

describe("resolveVercelProductionUrl()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to the linked project alias when inspect does not expose aliases", () => {
    vi.mocked(execFileSync).mockReturnValue(
      Buffer.from(JSON.stringify({ deployment: { url: "https://3am-receiver-jjzcdqapq-t-murase42s-projects.vercel.app" } })),
    );
    vi.mocked(existsSync).mockImplementation((path) => String(path).endsWith(".vercel/project.json"));
    vi.mocked(readFileSync).mockImplementation((path) => {
      if (String(path).endsWith(".vercel/project.json")) {
        return JSON.stringify({ projectName: "3am-receiver" });
      }
      return "";
    });

    const result = resolveVercelProductionUrl(
      "/repo",
      "https://3am-receiver-jjzcdqapq-t-murase42s-projects.vercel.app",
    );

    expect(result).toBe("https://3am-receiver.vercel.app");
  });

  it("prefers a stable production alias over the deployment-specific URL", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(execFileSync).mockReturnValue(
      Buffer.from(JSON.stringify({
        aliases: [
          "3am-receiver-qst762y4o-t-murase42s-projects.vercel.app",
          "3am-receiver.vercel.app",
        ],
      })),
    );

    const result = resolveVercelProductionUrl(
      "/repo",
      "https://3am-receiver-qst762y4o-t-murase42s-projects.vercel.app",
    );

    expect(result).toBe("https://3am-receiver.vercel.app");
  });

  it("falls back to the deployment URL when inspect fails", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("inspect failed");
    });

    const result = resolveVercelProductionUrl(
      "/repo",
      "https://3am-receiver-qst762y4o-t-murase42s-projects.vercel.app",
    );

    expect(result).toBe("https://3am-receiver-qst762y4o-t-murase42s-projects.vercel.app");
  });
});
