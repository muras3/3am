export type Framework = "nextjs" | "express" | "generic";

export function detectFramework(deps: Record<string, string>): Framework {
  if ("next" in deps) return "nextjs";
  if ("express" in deps) return "express";
  return "generic";
}
