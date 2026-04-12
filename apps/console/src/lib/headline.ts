export function extractTitle(headline: string): string {
  const trimmed = headline.trim();
  if (!trimmed) return "";

  const punctuationIndex = [...trimmed].findIndex((char, index, chars) => {
    if (![".", "?", "!", "。"].includes(char)) return false;
    const next = chars[index + 1];
    return next == null || next === " " || next === "\n" || char === "。";
  });
  if (punctuationIndex >= 0) {
    return trimmed.slice(0, punctuationIndex + 1).trim();
  }

  return trimmed;
}
