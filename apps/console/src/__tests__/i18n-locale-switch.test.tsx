/**
 * i18n locale switch tests — covers LocaleToggle behaviour, component locale
 * switching, and plural forms for both en and ja locales.
 */
import { render, screen, fireEvent, act } from "@testing-library/react";
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

/**
 * Render LevelHeader at level 0 (Map view), which always contains LocaleToggle.
 * We mock the router hooks that LevelHeader's sub-tree relies on so that the
 * component can mount without a full router context.
 */
async function renderLevelHeaderLevel0() {
  // LevelHeader uses useTranslation — no router hooks at level 0.
  // Dynamic import so vi.mock hoisting can take effect before the import.
  const { LevelHeader } = await import("../components/lens/LevelHeader.js");
  const zoomTo = vi.fn();
  return render(<LevelHeader level={0} zoomTo={zoomTo} />);
}

/**
 * The inactive locale button has an aria-label (e.g. "Switch language to
 * Japanese") which becomes its accessible name and replaces "JA" / "EN" in
 * ARIA queries.  Use getByText to always find by visible text content instead.
 */
function getLocaleBtn(label: "EN" | "JA") {
  // querySelectorAll finds both buttons; filter by text content.
  const btns = document.querySelectorAll<HTMLButtonElement>(".locale-toggle-btn");
  for (const btn of btns) {
    if (btn.textContent?.trim() === label) return btn;
  }
  throw new Error(`Locale button "${label}" not found`);
}

// ── 1. LocaleToggle unit tests ────────────────────────────────────────────────

describe("LocaleToggle", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
    );
  });

  it("renders EN and JA buttons", async () => {
    await act(async () => {
      await renderLevelHeaderLevel0();
    });
    expect(getLocaleBtn("EN")).toBeInTheDocument();
    expect(getLocaleBtn("JA")).toBeInTheDocument();
  });

  it("EN button has locale-toggle-active class when locale is en", async () => {
    await act(async () => {
      await renderLevelHeaderLevel0();
    });
    expect(getLocaleBtn("EN").className).toContain("locale-toggle-active");
    expect(getLocaleBtn("JA").className).not.toContain("locale-toggle-active");
  });

  it("clicking JA calls PUT /api/settings/locale with { locale: 'ja' } and changes language", async () => {
    await act(async () => {
      await renderLevelHeaderLevel0();
    });

    await act(async () => {
      fireEvent.click(getLocaleBtn("JA"));
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/settings/locale",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ locale: "ja" }),
      }),
    );
    expect(i18n.language).toBe("ja");
  });

  it("clicking EN calls PUT /api/settings/locale with { locale: 'en' } and changes language", async () => {
    // Start in Japanese so the EN click is an actual switch.
    await act(async () => {
      await i18n.changeLanguage("ja");
    });

    await act(async () => {
      await renderLevelHeaderLevel0();
    });

    await act(async () => {
      fireEvent.click(getLocaleBtn("EN"));
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/settings/locale",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ locale: "en" }),
      }),
    );
    expect(i18n.language).toBe("en");
  });

  it("JA button has locale-toggle-active class when locale is ja", async () => {
    await act(async () => {
      await i18n.changeLanguage("ja");
    });

    await act(async () => {
      await renderLevelHeaderLevel0();
    });

    expect(getLocaleBtn("JA").className).toContain("locale-toggle-active");
    expect(getLocaleBtn("EN").className).not.toContain("locale-toggle-active");
  });

  it("inactive EN button has aria-label when locale is ja", async () => {
    await act(async () => {
      await i18n.changeLanguage("ja");
    });

    await act(async () => {
      await renderLevelHeaderLevel0();
    });

    // When EN is not active, it should carry the aria-label for switching.
    expect(getLocaleBtn("EN")).toHaveAttribute("aria-label");
  });

  it("inactive JA button has aria-label when locale is en", async () => {
    await act(async () => {
      await renderLevelHeaderLevel0();
    });

    // When JA is not active, it should carry the aria-label for switching.
    expect(getLocaleBtn("JA")).toHaveAttribute("aria-label");
  });

  it("active EN button does not have an aria-label (its text is already descriptive)", async () => {
    await act(async () => {
      await renderLevelHeaderLevel0();
    });

    // The active button (EN when locale=en) has no aria-label — visible text suffices.
    expect(getLocaleBtn("EN")).not.toHaveAttribute("aria-label");
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
