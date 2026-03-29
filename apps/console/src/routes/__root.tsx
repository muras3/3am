import { Suspense } from "react";
import { createRootRouteWithContext, stripSearchParams, useSearch } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { parseIncidentId } from "../lib/incidentId.js";
import { LensShell } from "../components/lens/LensShell.js";

export interface RouterContext {
  queryClient: QueryClient;
}

// ── URL search param types ────────────────────────────────────

export type LensLevel = 0 | 1 | 2;
export type EvidenceTab = "traces" | "metrics" | "logs";

export interface LensSearchParams {
  incidentId?: string | undefined;
  level?: LensLevel | undefined;
  tab?: EvidenceTab | undefined;
  proof?: string | undefined;
  targetId?: string | undefined;
  query?: string | undefined;
}

/** Defaults that should NOT appear in the URL bar. */
const SEARCH_DEFAULTS = { level: 0 as LensLevel, tab: "traces" as EvidenceTab };

/** Hook that returns search params with defaults guaranteed. */
export function useLensSearch() {
  const s = useSearch({ from: "__root__" }) as LensSearchParams;
  return {
    ...s,
    level: (s.level ?? SEARCH_DEFAULTS.level) as LensLevel,
    tab: (s.tab ?? SEARCH_DEFAULTS.tab) as EvidenceTab,
  };
}

function parseLensLevel(value: unknown): LensLevel {
  if (value === 1 || value === "1") return 1;
  if (value === 2 || value === "2") return 2;
  return 0;
}

function parseEvidenceTab(value: unknown): EvidenceTab {
  if (value === "metrics") return "metrics";
  if (value === "logs") return "logs";
  return "traces";
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  search: {
    middlewares: [stripSearchParams(SEARCH_DEFAULTS)],
  },
  validateSearch: (search: Record<string, unknown>): LensSearchParams => {
    const incidentId = parseIncidentId(search["incidentId"]);
    const level = parseLensLevel(search["level"]);
    // Auto-derive level from incidentId when level is not explicitly set
    const effectiveLevel: LensLevel =
      level === 0 && incidentId ? 1 : level;

    return {
      incidentId,
      level: effectiveLevel,
      tab: parseEvidenceTab(search["tab"]),
      proof: parseOptionalString(search["proof"]),
      targetId: parseOptionalString(search["targetId"]),
      query: parseOptionalString(search["query"]),
    };
  },
  component: () => (
    <Suspense fallback={null}>
      <LensShell />
    </Suspense>
  ),
});
