import { render, screen, act, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AUTH_FAILURE_EVENT } from "../api/client.js";
import { SetupGate } from "../components/setup-gate.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SetupGate", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, document.title, "/");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    window.history.replaceState({}, document.title, "/");
  });

  it("exchanges a claim token from the URL hash and enters the app", async () => {
    window.history.replaceState({}, document.title, "/#claim=claim-token");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/claims/exchange") {
        return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    }));

    await act(async () => {
      render(
        <SetupGate>
          <div>ready</div>
        </SetupGate>,
      );
      await flushMicrotasks();
    });

    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(window.location.hash).toBe("");
  });

  it("shows claim-required screen when no active session exists", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/settings/diagnosis") {
        return Promise.resolve(new Response("unauthorized", { status: 401 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    }));

    await act(async () => {
      render(
        <SetupGate>
          <div>ready</div>
        </SetupGate>,
      );
      await flushMicrotasks();
    });

    expect(await screen.findByText("Open Your Sign-In Link")).toBeInTheDocument();
    expect(screen.queryByText("ready")).not.toBeInTheDocument();
  });

  it("returns to claim-required screen on auth failure", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/settings/diagnosis") {
        return Promise.resolve(new Response(JSON.stringify({ mode: "automatic", bridgeUrl: "" }), { status: 200 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    }));

    await act(async () => {
      render(
        <SetupGate>
          <div>app content</div>
        </SetupGate>,
      );
      await flushMicrotasks();
    });

    expect(await screen.findByText("app content")).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new CustomEvent(AUTH_FAILURE_EVENT));
      await flushMicrotasks();
    });

    expect(await screen.findByText("Open Your Sign-In Link")).toBeInTheDocument();
    expect(screen.queryByText("app content")).not.toBeInTheDocument();
  });
});
