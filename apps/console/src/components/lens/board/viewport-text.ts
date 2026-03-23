export function shortenForViewport(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;

  const boundary = trimmed.lastIndexOf(" ", maxChars - 1);
  const cutoff = boundary > Math.floor(maxChars * 0.6) ? boundary : maxChars - 1;
  return `${trimmed.slice(0, cutoff).trimEnd()}…`;
}

export function splitActionForViewport(text: string, maxSteps = 3): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const parts = trimmed
    .split(/\s*(?:,\s+| and (?=[a-z])| then (?=[a-z]))/i)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    return [shortenForViewport(trimmed, 84)];
  }

  return parts.slice(0, maxSteps);
}
