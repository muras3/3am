import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../commands/dev.js", () => ({
  runDev: vi.fn(),
}));

vi.mock("../commands/demo.js", () => ({
  runDemo: vi.fn(),
}));

import { runDev } from "../commands/dev.js";
import { runDemo } from "../commands/demo.js";
import { runLocal } from "../commands/local.js";

describe("runLocal()", () => {
  beforeEach(() => {
    vi.mocked(runDev).mockReset();
    vi.mocked(runDemo).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts the local receiver by default", async () => {
    await runLocal({});

    expect(runDev).toHaveBeenCalledWith({});
    expect(runDemo).not.toHaveBeenCalled();
  });

  it("starts the local receiver explicitly", async () => {
    await runLocal({ action: "start", port: 4444 });

    expect(runDev).toHaveBeenCalledWith({ port: 4444 });
    expect(runDemo).not.toHaveBeenCalled();
  });

  it("runs the local demo flow", async () => {
    await runLocal({
      action: "demo",
      yes: true,
      noInteractive: true,
      receiverUrl: "http://localhost:4444",
    });

    expect(runDemo).toHaveBeenCalledWith([], {
      yes: true,
      noInteractive: true,
      receiverUrl: "http://localhost:4444",
    });
    expect(runDev).not.toHaveBeenCalled();
  });

  it("exits on unknown action", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runLocal({ action: "bogus" });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalled();
  });
});
