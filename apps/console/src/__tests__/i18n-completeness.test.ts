/**
 * i18n completeness tests — ensures en.json and ja.json stay in sync.
 * Catches missing keys, extra keys, and empty values.
 */
import { describe, it, expect } from "vitest";
import en from "../i18n/en.json";
import ja from "../i18n/ja.json";

function getLeafKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null
      ? getLeafKeys(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

function getLeafValues(obj: Record<string, unknown>, prefix = ""): [string, string][] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null
      ? getLeafValues(v as Record<string, unknown>, `${prefix}${k}.`)
      : [[`${prefix}${k}`, String(v)] as [string, string]],
  );
}

describe("i18n completeness", () => {
  const enKeys = getLeafKeys(en).sort();
  const jaKeys = getLeafKeys(ja).sort();

  it("en.json and ja.json have identical key sets", () => {
    const missingFromJa = enKeys.filter((k) => !jaKeys.includes(k));
    const extraInJa = jaKeys.filter((k) => !enKeys.includes(k));

    expect(missingFromJa).toEqual([]);
    expect(extraInJa).toEqual([]);
    expect(enKeys.length).toBe(jaKeys.length);
  });

  it("no en.json values are empty strings", () => {
    const empty = getLeafValues(en).filter(([, v]) => v === "");
    expect(empty).toEqual([]);
  });

  it("no ja.json values are empty strings", () => {
    const empty = getLeafValues(ja).filter(([, v]) => v === "");
    expect(empty).toEqual([]);
  });

  it("interpolation variables are preserved in ja.json", () => {
    const enEntries = getLeafValues(en);
    const jaMap = new Map(getLeafValues(ja));

    const mismatches: string[] = [];
    for (const [key, enVal] of enEntries) {
      const vars = enVal.match(/\{\{[^}]+\}\}/g) ?? [];
      if (vars.length === 0) continue;

      const jaVal = jaMap.get(key) ?? "";
      for (const v of vars) {
        if (!jaVal.includes(v)) {
          mismatches.push(`${key}: missing ${v} in ja.json`);
        }
      }
    }

    expect(mismatches).toEqual([]);
  });
});
