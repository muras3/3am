/**
 * i18n locale tests — covers shared translation behaviour and the header's
 * locale-independent chrome.
 */
import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeAll, afterEach, beforeEach } from "vitest";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../i18n/en.json";
import ja from "../i18n/ja.json";

// ── i18next setup with both locales ───────────────────────────────────────────
// The shared setup.ts only loads English. Re-initialise here with both so that
// changeLanguage("ja") works correctly in all three test suites.

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      lng: "en",
      fallbackLng: "en",
      resources: {
        en: { translation: en },
        ja: { translation: ja },
      },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
  } else {
    // Already initialised by setup.ts — add the ja resource bundle if missing.
    if (!i18n.hasResourceBundle("ja", "translation")) {
      i18n.addResourceBundle("ja", "translation", ja);
    }
    await i18n.changeLanguage("en");
  }
});

afterEach(async () => {
  // Reset locale to English so tests don't bleed into each other.
  await act(async () => {
    await i18n.changeLanguage("en");
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function renderLevelHeaderLevel0() {
  const { LevelHeader } = await import("../components/lens/LevelHeader.js");
  const zoomTo = vi.fn();
  return render(<LevelHeader level={0} zoomTo={zoomTo} />);
}
// ── 1. Header chrome ──────────────────────────────────────────────────────────

describe("LevelHeader", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ locale: "en" }) }),
    );
  });

  it("does not render locale toggle controls in the header", async () => {
    let view: Awaited<ReturnType<typeof renderLevelHeaderLevel0>> | undefined;
    await act(async () => {
      view = await renderLevelHeaderLevel0();
    });
    const { container } = view!;
    expect(container.querySelector(".locale-toggle")).toBeNull();
    expect(container.querySelector(".locale-toggle-btn")).toBeNull();
  });

  it("formats the header clock in local time with a timezone label", async () => {
    const { formatTime } = await import("../components/lens/LevelHeader.js");
    const dateTimeFormatSpy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      () =>
        ({
          format: () => "ignored",
          formatToParts: () => ([
            { type: "hour", value: "14" },
            { type: "literal", value: ":" },
            { type: "minute", value: "30" },
            { type: "literal", value: ":" },
            { type: "second", value: "05" },
            { type: "literal", value: " " },
            { type: "timeZoneName", value: "JST" },
          ]),
        }) as Intl.DateTimeFormat,
    );

    expect(formatTime(new Date("2026-03-29T05:30:05.000Z"))).toBe("14:30:05 JST");
    expect(dateTimeFormatSpy).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "short",
      }),
    );
  });
});

// ── 2. Component locale switch ────────────────────────────────────────────────

describe("Component locale switch via i18n.t()", () => {
  it("board.immediateAction.title returns 'Immediate Action' in English", () => {
    expect(i18n.t("board.immediateAction.title")).toBe("Immediate Action");
  });

  it("board.immediateAction.title returns '今すぐやること' in Japanese", async () => {
    await act(async () => {
      await i18n.changeLanguage("ja");
    });
    expect(i18n.t("board.immediateAction.title")).toBe("今すぐやること");
  });

  it("common.error.reload returns 'Reload' in English then '再読み込み' in Japanese, then back", async () => {
    expect(i18n.t("common.error.reload")).toBe("Reload");

    await act(async () => {
      await i18n.changeLanguage("ja");
    });
    expect(i18n.t("common.error.reload")).toBe("再読み込み");

    await act(async () => {
      await i18n.changeLanguage("en");
    });
    expect(i18n.t("common.error.reload")).toBe("Reload");
  });

  it("ErrorBoundary fallback shows localised reload button after language change", async () => {
    const { ErrorBoundary } = await import("../components/common/ErrorBoundary.js");

    function ThrowingComponent(): never {
      throw new Error("locale test error");
    }

    vi.spyOn(console, "error").mockImplementation(() => {});

    // English
    const { unmount } = render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    unmount();

    // Switch to Japanese and re-render
    await act(async () => {
      await i18n.changeLanguage("ja");
    });

    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeInTheDocument();
  });
});

// ── 3. Plural forms ───────────────────────────────────────────────────────────

describe("Plural forms — board.blastRadius.morePaths", () => {
  it("English singular: count=1 → '1 more impacted path'", () => {
    expect(i18n.t("board.blastRadius.morePaths", { count: 1 })).toContain("1 more impacted path");
  });

  it("English plural: count=3 → '3 more impacted paths'", () => {
    expect(i18n.t("board.blastRadius.morePaths", { count: 3 })).toContain("3 more impacted paths");
  });

  it("English singular does NOT contain 'paths' (no trailing s)", () => {
    const result = i18n.t("board.blastRadius.morePaths", { count: 1 });
    // "1 more impacted path" — must not end with "paths"
    expect(result).not.toMatch(/paths/);
  });

  it("Japanese count=1 uses same form as count=3 (no grammatical plural in Japanese)", async () => {
    await act(async () => {
      await i18n.changeLanguage("ja");
    });

    const single = i18n.t("board.blastRadius.morePaths", { count: 1 });
    const plural = i18n.t("board.blastRadius.morePaths", { count: 3 });

    // Both keys map to the same template in ja.json ("他 {{count}} 件の影響パス")
    expect(single).toBe("他 1 件の影響パス");
    expect(plural).toBe("他 3 件の影響パス");

    // The structural template is the same — only the interpolated count differs.
    const singleTemplate = single.replace(/\d+/, "N");
    const pluralTemplate = plural.replace(/\d+/, "N");
    expect(singleTemplate).toBe(pluralTemplate);
  });

  it("Japanese morePaths_one and morePaths_other resolve to the same template", async () => {
    await act(async () => {
      await i18n.changeLanguage("ja");
    });

    // Verify the underlying JSON values are identical templates.
    const jaTranslation = i18n.getResourceBundle("ja", "translation") as typeof ja;
    expect(jaTranslation.board.blastRadius.morePaths_one).toBe(
      jaTranslation.board.blastRadius.morePaths_other,
    );
  });
});
