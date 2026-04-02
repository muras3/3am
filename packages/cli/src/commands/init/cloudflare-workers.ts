import { readFileSync, writeFileSync } from "node:fs";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureTomlTable(content: string, table: string, entries: Record<string, string>): string {
  const header = `[${table}]`;
  const tableRegex = new RegExp(`(^\\[${escapeRegExp(table)}\\]\\n[\\s\\S]*?)(?=^\\[|\\Z)`, "m");
  const entryLines = Object.entries(entries);

  if (tableRegex.test(content)) {
    return content.replace(tableRegex, (block) => {
      let updated = block;
      for (const [key, value] of entryLines) {
        const keyRegex = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");
        const line = `${key} = ${value}`;
        if (keyRegex.test(updated)) {
          updated = updated.replace(keyRegex, line);
        } else {
          updated = updated.endsWith("\n") ? `${updated}${line}\n` : `${updated}\n${line}\n`;
        }
      }
      return updated;
    });
  }

  const block = [
    header,
    ...entryLines.map(([key, value]) => `${key} = ${value}`),
    "",
  ].join("\n");

  return content.trimEnd() === "" ? `${block}\n` : `${content.trimEnd()}\n\n${block}\n`;
}

function stripJsonComments(source: string): string {
  let result = "";
  let inString = false;
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    const next = source[i + 1];

    if (inString) {
      result += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === quote) {
        inString = false;
        quote = null;
      }
      continue;
    }

    if ((char === "\"" || char === "'")) {
      inString = true;
      quote = char;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      result += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }

    result += char;
  }

  return result;
}

function parseJsoncObject(content: string): Record<string, unknown> {
  const stripped = stripJsonComments(content).replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(stripped) as Record<string, unknown>;
}

function stringifyJsoncObject(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function updateWranglerToml(content: string): string {
  let updated = content;
  updated = ensureTomlTable(updated, "observability", { enabled: "true" });
  updated = ensureTomlTable(updated, "observability.logs", {
    enabled: "true",
    invocation_logs: "true",
  });
  updated = ensureTomlTable(updated, "observability.traces", {
    enabled: "true",
    head_sampling_rate: "1.0",
  });
  return updated;
}

function updateWranglerJsonc(content: string): string {
  const parsed = parseJsoncObject(content);
  const observability = ((parsed["observability"] as Record<string, unknown> | undefined) ?? {});
  const logs = ((observability["logs"] as Record<string, unknown> | undefined) ?? {});
  const traces = ((observability["traces"] as Record<string, unknown> | undefined) ?? {});

  parsed["observability"] = {
    ...observability,
    enabled: true,
    logs: {
      ...logs,
      enabled: true,
      invocation_logs: true,
    },
    traces: {
      ...traces,
      enabled: true,
      head_sampling_rate: 1,
    },
  };

  return stringifyJsoncObject(parsed);
}

export function updateCloudflareObservabilityConfig(path: string): boolean {
  const content = readFileSync(path, "utf-8");
  const updated = path.endsWith(".jsonc") ? updateWranglerJsonc(content) : updateWranglerToml(content);

  if (updated === content) return false;

  writeFileSync(path, updated, "utf-8");
  return true;
}
