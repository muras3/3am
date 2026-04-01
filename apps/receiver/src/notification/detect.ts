export type Provider = "slack" | "discord";

export function detectProvider(
  url: string,
  opts?: { allowInsecure?: boolean }
): Provider | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const allowInsecure = opts?.allowInsecure === true;
  if (parsed.protocol !== "https:" && !(allowInsecure && parsed.protocol === "http:")) {
    return null;
  }

  const hostname = parsed.hostname;

  if (hostname === "hooks.slack.com") {
    return "slack";
  }

  if (hostname === "discord.com" || hostname === "discordapp.com") {
    return "discord";
  }

  return null;
}
