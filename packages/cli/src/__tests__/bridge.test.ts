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

  it("does not attempt a remote WebSocket connection for Vercel receivers", async () => {
    const port = 5270 + Math.floor(Math.random() * 1000);
    const webSocketSpy = vi.fn();
    const originalWebSocket = globalThis.WebSocket;
    vi.stubGlobal("WebSocket", webSocketSpy);

    // Mock fetch to prevent real HTTP calls from the poll loop
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ job: null }),
    }));

    const bridge = runBridge({
      port,
      receiverUrl: "https://receiver-example.vercel.app",
      registerSignalHandlers: false,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(webSocketSpy).not.toHaveBeenCalled();
    } finally {
      bridge.close();
      vi.stubGlobal("WebSocket", originalWebSocket);
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("starts poll loop for Vercel receivers and calls GET /api/bridge/jobs", async () => {
    const port = 5370 + Math.floor(Math.random() * 1000);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ job: null }),
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", fetchMock);

    const bridge = runBridge({
      port,
      receiverUrl: "https://receiver-example.vercel.app",
      registerSignalHandlers: false,
    });

    try {
      // Wait for the initial poll to fire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check that the poll hit GET /api/bridge/jobs
      const bridgeCalls = fetchMock.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("/api/bridge/jobs"),
      );
      expect(bridgeCalls.length).toBeGreaterThanOrEqual(1);

      const [url, opts] = bridgeCalls[0] as [string, { method: string; headers: Record<string, string> }];
      expect(url).toBe("https://receiver-example.vercel.app/api/bridge/jobs");
      expect(opts.method).toBe("GET");
    } finally {
      bridge.close();
      vi.stubGlobal("fetch", originalFetch);
    }
  });
});
