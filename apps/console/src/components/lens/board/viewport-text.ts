import i18n from "../../../i18n/index.js";

export function shortenForViewport(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;

  const boundary = trimmed.lastIndexOf(" ", maxChars - 1);
  const cutoff = boundary > Math.floor(maxChars * 0.6) ? boundary : maxChars - 1;
  return `${trimmed.slice(0, cutoff).trimEnd()}…`;
}

/**
 * A list-marker pattern: matches "1) ", "1. ", or "- " appearing either at
 * the start of the string, after a newline, or after whitespace mid-sentence.
 */
const LIST_MARKER_RE = /(?:^|(?<=\s))(\d+[.)]\s+|-\s+)/g;

/**
 * Detect whether text contains numbered/bulleted list patterns such as:
 *   "1) ...", "1. ...", "- ..."
 * Returns true if 2+ such markers are found anywhere in the text.
 */
function hasNumberedListPattern(text: string): boolean {
  const matches = Array.from(text.matchAll(LIST_MARKER_RE));
  return matches.length >= 2;
}

/**
 * Split text that uses numbered/bulleted list markers into an array of step
 * strings, stripping the leading marker from each item.
 *
 * Handles inline sequences like "1) Do A 2) Do B 3) Do C" (no newlines) as
 * well as properly newline-separated lists.
 */
function splitNumberedList(text: string): string[] {
  // Insert a sentinel newline before each marker occurrence (after any
  // leading whitespace) so we can then split cleanly on newlines.
  const normalized = text.replace(
    /(\s+)(?=\d+[.)]\s+|-\s+)/g,
    "\n"
  );

  return normalized
    .split(/\n/)
    .map((line) => line.replace(/^\s*(?:\d+[.)]\s+|-\s+)/, "").trim())
    .filter(Boolean);
}

/**
 * Split action text into steps for viewport display.
 * Priority order:
 *   1. Numbered/bulleted list patterns (1) ... 2) ..., 1. ... 2. ..., - ... - ...)
 *   2. Japanese clause delimiters (、/ 。)
 *   3. English conjunctive delimiters (, / and / then)
 */
export function splitActionForViewport(text: string, maxSteps = 6): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Priority 1: numbered/bulleted lists
  if (hasNumberedListPattern(trimmed)) {
    const parts = splitNumberedList(trimmed).filter(Boolean);
    if (parts.length >= 2) {
      return parts.slice(0, maxSteps);
    }
  }

  const locale = i18n.language;

  // Priority 2: Japanese
  if (locale === "ja") {
    const parts = trimmed
      .split(/[、。]/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length > 1) return parts.slice(0, maxSteps);
    return [trimmed];
  }

  // Priority 3: English conjunctive delimiters
  const parts = trimmed
    .split(/\s*(?:,\s+| and (?=[a-z])| then (?=[a-z]))/i)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    return [trimmed];
  }

  return parts.slice(0, maxSteps);
}
