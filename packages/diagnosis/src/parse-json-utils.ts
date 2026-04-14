/**
 * Shared JSON extraction utilities for evidence parsers.
 *
 * LLM responses often contain JSON wrapped in prose or code fences.
 * These helpers normalize output from all three extraction patterns.
 */

/**
 * Extracts JSON from model output that may contain prose and/or code fences.
 *
 * Strategy (in order):
 *  1. Direct JSON.parse (clean output)
 *  2. Extract content from the first ```...``` code fence (handles prose before/after fence)
 *  3. Extract from first '{' to last '}' (handles prose wrapping raw JSON without fences)
 */
export function parseJsonFromModelOutput(raw: string): unknown {
  // Attempt 1: direct parse
  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }

  // Attempt 2: first code fence (allow any prose before/after)
  const fenceMatch = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(raw);
  if (fenceMatch?.[1] !== undefined) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // continue to attempt 3
    }
  }

  // Attempt 3: first '{' to last '}'
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      // fall through to throw
    }
  }

  throw new Error("Failed to parse model output as JSON");
}

/**
 * Injects sequential `id` fields into segments that are missing them.
 * LLMs sometimes omit ids; this ensures downstream schema validation passes.
 */
export function injectSegmentIds(parsedSegments: unknown): unknown {
  if (!Array.isArray(parsedSegments)) return parsedSegments;

  return parsedSegments.map((segment, index) => {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
      return segment;
    }

    const record = segment as Record<string, unknown>;
    if (typeof record["id"] === "string" && record["id"].length > 0) {
      return record;
    }

    return {
      ...record,
      id: `seg_${index + 1}`,
    };
  });
}
