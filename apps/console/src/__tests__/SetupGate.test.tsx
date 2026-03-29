import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import i18n from "i18next";
import { SetupGate } from "../components/setup-gate.js";

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
});
