import { queryOptions } from "@tanstack/react-query";
import { apiFetch, apiFetchPost } from "./client.js";
import { encodeIncidentId } from "../lib/incidentId.js";
import type {
  Incident,
  IncidentPage,
  TelemetrySpan,
  TelemetryMetric,
  TelemetryLogsResponse,
  RecentActivity,
  ServiceSurface,
} from "./types.js";
import type {
  RuntimeMapResponse,
  ExtendedIncident,
} from "./curated-types.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export async function sendChatMessage(
  incidentId: string,
  message: string,
  history: ChatTurn[],
): Promise<{ reply: string }> {
  return apiFetchPost<{ reply: string }>(`/api/chat/${encodeIncidentId(incidentId)}`, {
    message,
    history,
  });
}

export const incidentQueries = {
  list: () =>
    queryOptions({
      queryKey: ["incidents"],
      queryFn: () => apiFetch<IncidentPage>("/api/incidents?limit=20"),
      staleTime: 30_000,
      refetchInterval: 15_000,
    }),

  detail: (id: string) =>
    queryOptions({
      queryKey: ["incidents", id],
      queryFn: () => apiFetch<Incident>(`/api/incidents/${encodeIncidentId(id)}`),
      staleTime: 15_000,
      refetchInterval: 10_000,
    }),

  telemetrySpans: (id: string) =>
    queryOptions({
      queryKey: ["incidents", id, "telemetry", "spans"],
      queryFn: () => apiFetch<TelemetrySpan[]>(`/api/incidents/${encodeIncidentId(id)}/telemetry/spans`),
      staleTime: 30_000,
      enabled: !!id,
    }),

  telemetryMetrics: (id: string) =>
    queryOptions({
      queryKey: ["incidents", id, "telemetry", "metrics"],
      queryFn: () => apiFetch<TelemetryMetric[]>(`/api/incidents/${encodeIncidentId(id)}/telemetry/metrics`),
      staleTime: 30_000,
      enabled: !!id,
    }),

  telemetryLogs: (id: string) =>
    queryOptions({
      queryKey: ["incidents", id, "telemetry", "logs"],
      queryFn: () => apiFetch<TelemetryLogsResponse>(`/api/incidents/${encodeIncidentId(id)}/telemetry/logs`),
      staleTime: 30_000,
      enabled: !!id,
    }),
};

// ── Curated API queries (Lens UI) ─────────────────────────────
// These consume the new curated endpoints. Fixture mode is supported
// via VITE_USE_FIXTURES env var — when true, queries return static
// fixture data instead of fetching from the API.

const useFixtures = import.meta.env?.VITE_USE_FIXTURES === "true";

const fixtureVariant: string = import.meta.env?.VITE_FIXTURE_VARIANT || "ready";

async function loadFixture<T>(loader: () => Promise<T>): Promise<T> {
  return loader();
}

export const curatedQueries = {
  runtimeMap: () =>
    queryOptions({
      queryKey: ["curated", "runtime-map"],
      queryFn: useFixtures
        ? () => loadFixture(async () => {
            const m = await import("../__fixtures__/curated/runtime-map.js");
            if (fixtureVariant === "sparse") return m.runtimeMapSparse;
            if (fixtureVariant === "unavailable") return m.runtimeMapUnavailable;
            return m.runtimeMapReady;
          })
        : () => apiFetch<RuntimeMapResponse>("/api/runtime-map"),
      staleTime: 15_000,
      refetchInterval: useFixtures ? false : 15_000,
    }),

  extendedIncident: (id: string) =>
    queryOptions({
      queryKey: ["curated", "incidents", id],
      queryFn: useFixtures
        ? () => loadFixture(async () => {
            const m = await import("../__fixtures__/curated/extended-incident.js");
            if (fixtureVariant === "pending") return m.extendedIncidentPending;
            if (fixtureVariant === "sparse") return m.extendedIncidentSparse;
            return m.extendedIncidentReady;
          })
        : () => apiFetch<ExtendedIncident>(`/api/incidents/${encodeIncidentId(id)}`),
      staleTime: 15_000,
      refetchInterval: useFixtures ? false : 10_000,
      enabled: !!id,
    }),
};

// ── Legacy queries (raw APIs — kept for gate-off UI) ──────────

export const ambientQueries = {
  services: () =>
    queryOptions({
      queryKey: ["ambient", "services"],
      queryFn: () => apiFetch<ServiceSurface[]>("/api/services"),
      staleTime: 15_000,
      refetchInterval: 30_000,
    }),

  activity: (limit = 12) =>
    queryOptions({
      queryKey: ["ambient", "activity", limit],
      queryFn: () => apiFetch<RecentActivity[]>(`/api/activity?limit=${limit}`),
      staleTime: 10_000,
      refetchInterval: 15_000,
    }),
};
