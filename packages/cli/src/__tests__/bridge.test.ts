import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAllowedBridgeOrigin, runBridge } from "../commands/bridge.js";

describe("bridge origin guard", () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "threeam-bridge-test-"));
    originalHome = process.env["HOME"];
    process.env["HOME"] = homeDir;
  });

  afterEach(() => {
    process.env["HOME"] = originalHome;
    rmSync(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("allows loopback and matching receiver origins, and blocks unrelated origins", () => {
    expect(isAllowedBridgeOrigin(undefined, "https://receiver.example.com")).toBe(true);
    expect(isAllowedBridgeOrigin("http://localhost:3333", "https://receiver.example.com")).toBe(true);
    expect(isAllowedBridgeOrigin("http://127.0.0.1:5173", "https://receiver.example.com")).toBe(true);
    expect(isAllowedBridgeOrigin("https://receiver.example.com", "https://receiver.example.com/path")).toBe(true);
    expect(isAllowedBridgeOrigin("https://evil.example.com", "https://receiver.example.com")).toBe(false);
  });

  it("rejects browser requests from untrusted origins and echoes allowed origins", async () => {
    const port = 4270 + Math.floor(Math.random() * 1000);
    const bridge = runBridge({
      port,
      receiverUrl: "https://receiver.example.com",
      registerSignalHandlers: false,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));

      const blocked = await fetch(`http://127.0.0.1:${port}/healthz`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toEqual({ error: "origin not allowed" });

      const allowed = await fetch(`http://127.0.0.1:${port}/healthz`, {
        headers: { Origin: "https://receiver.example.com" },
      });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("access-control-allow-origin")).toBe("https://receiver.example.com");

      const loopback = await fetch(`http://127.0.0.1:${port}/healthz`, {
        headers: { Origin: "http://localhost:3333" },
      });
      expect(loopback.status).toBe(200);
      expect(loopback.headers.get("access-control-allow-origin")).toBe("http://localhost:3333");
    } finally {
      bridge.close();
    }
  });
});
