import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { resolveVercelProductionUrl } from "../commands/deploy/provider.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

describe("resolveVercelProductionUrl()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers a stable production alias over the deployment-specific URL", () => {
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
