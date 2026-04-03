import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import i18n from "i18next";
import { SetupGate } from "../components/setup-gate.js";
import { AUTH_FAILURE_EVENT } from "../api/client.js";

describe("SetupGate", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/setup-status") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ setupComplete: false }) });
      }
      if (url === "/api/setup-token") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: "secret-token" }) });
      }
      if (url === "/api/settings/locale") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ locale: "ja" }) });
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url} ${init?.method ?? "GET"}`));
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    await i18n.changeLanguage("en");
  });

  it("shows content-language choices during first setup and persists the selection", async () => {
    const user = userEvent.setup();

    await act(async () => {
      render(
        <SetupGate>
          <div>ready</div>
        </SetupGate>,
      );
    });

    expect(await screen.findByText("Content Language")).toBeInTheDocument();
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Japanese/i }));
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Continue/i }));
    });

    expect(localStorage.getItem("receiver_auth_token")).toBe("secret-token");
    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(i18n.language).toBe("ja");
  });

  it("switches to recovery screen when AUTH_FAILURE_EVENT is dispatched", async () => {
    // Start in ready state (token already in localStorage)
    localStorage.setItem("receiver_auth_token", "valid-token");

    await act(async () => {
      render(
        <SetupGate>
          <div>app content</div>
        </SetupGate>,
      );
    });

    // App should be showing content
    expect(await screen.findByText("app content")).toBeInTheDocument();

    // Simulate auth failure (e.g. token became invalid after D1 re-creation)
    await act(async () => {
      window.dispatchEvent(new CustomEvent(AUTH_FAILURE_EVENT));
    });

    // Should show recovery screen (Enter Auth Token)
    expect(await screen.findByText("Enter Auth Token")).toBeInTheDocument();
    expect(screen.queryByText("app content")).not.toBeInTheDocument();
  });

  it("recovers from auth failure after entering a new token", async () => {
    const user = userEvent.setup();

    // Start in ready state
    localStorage.setItem("receiver_auth_token", "valid-token");

    await act(async () => {
      render(
        <SetupGate>
          <div>app content</div>
        </SetupGate>,
      );
    });

    expect(await screen.findByText("app content")).toBeInTheDocument();

    // Auth failure
    await act(async () => {
      window.dispatchEvent(new CustomEvent(AUTH_FAILURE_EVENT));
    });

    expect(await screen.findByText("Enter Auth Token")).toBeInTheDocument();

    // Enter new token
    const input = screen.getByPlaceholderText("Paste your auth token here");
    await act(async () => {
      await user.type(input, "new-valid-token");
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Save and Continue/i }));
    });

    // Should be back to ready state
    expect(await screen.findByText("app content")).toBeInTheDocument();
    expect(localStorage.getItem("receiver_auth_token")).toBe("new-valid-token");
  });
});
