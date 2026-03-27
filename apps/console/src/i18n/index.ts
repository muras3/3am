import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import ja from "./ja.json";

/**
 * Detect the preferred locale from navigator.languages.
 * Returns "ja" if any navigator language starts with "ja", otherwise "en".
 */
function detectBrowserLocale(): "en" | "ja" {
  if (typeof navigator === "undefined") return "en";
  for (const lang of navigator.languages ?? []) {
    if (lang.startsWith("ja")) return "ja";
  }
  return "en";
}

/**
 * Initialize locale from the server setting, falling back to browser detection.
 * On first visit, POSTs the detected locale to the server so it persists.
 */
async function resolveLocale(): Promise<"en" | "ja"> {
  try {
    const res = await fetch("/api/settings/locale");
    if (res.ok) {
      const data = (await res.json()) as { locale?: string };
      if (data.locale === "ja" || data.locale === "en") {
        return data.locale;
      }
    }
  } catch {
    // API unavailable (dev mode, etc.) — fall through to browser detection
  }

  const detected = detectBrowserLocale();

  // Best-effort persist the detected locale
  try {
    await fetch("/api/settings/locale", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: detected }),
    });
  } catch {
    // Ignore — locale will still work in-memory
  }

  return detected;
}

// Start resolving locale immediately (non-blocking)
const localePromise = resolveLocale();

void i18n.use(initReactI18next).init({
  lng: "en", // start with English, will switch after resolveLocale completes
  fallbackLng: "en",
  resources: {
    en: { translation: en },
    ja: { translation: ja },
  },
  interpolation: {
    escapeValue: false, // React already escapes
  },
  react: {
    useSuspense: false,
  },
});

// Switch language once the server locale is resolved
void localePromise.then((locale) => {
  if (locale !== i18n.language) {
    void i18n.changeLanguage(locale);
  }
});

export default i18n;
