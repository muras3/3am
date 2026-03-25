import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { apiFetch, apiFetchPost } from "./client.js";
import { encodeIncidentId } from "../lib/incidentId.js";
import type {
  RuntimeMapResponse,
  ExtendedIncident,
  EvidenceResponse,
  EvidenceQueryResponse,
} from "./curated-types.js";

// ── Fixture mode ──────────────────────────────────────────────

const useFixtures = import.meta.env?.VITE_USE_FIXTURES === "true";
const fixtureVariant: string = import.meta.env?.VITE_FIXTURE_VARIANT || "ready";

async function loadFixture<T>(loader: () => Promise<T>): Promise<T> {
  return loader();
}

// ── Curated API queries ───────────────────────────────────────

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

  evidence: (id: string) =>
    queryOptions({
      queryKey: ["curated", "incidents", id, "evidence"],
      queryFn: useFixtures
        ? () => loadFixture(async () => {
            const m = await import("../__fixtures__/curated/evidence.js");
            if (fixtureVariant === "pending") return m.evidencePending;
            if (fixtureVariant === "sparse") return m.evidenceSparse;
            return m.evidenceReady;
          })
        : () => apiFetch<EvidenceResponse>(`/api/incidents/${encodeIncidentId(id)}/evidence`),
      staleTime: 30_000,
      ...(useFixtures && { refetchInterval: false as const }),
      enabled: !!id,
    }),
};

export interface EvidenceQueryRequest {
  question: string;
  isFollowup?: boolean;
}

export interface RerunDiagnosisResponse {
  status: "accepted";
}

export const curatedMutations = {
  evidenceQuery: (id: string) =>
    mutationOptions({
      mutationKey: ["curated", "incidents", id, "evidence-query"],
      mutationFn: (body: EvidenceQueryRequest) =>
        apiFetchPost<EvidenceQueryResponse>(`/api/incidents/${encodeIncidentId(id)}/evidence/query`, body),
    }),

  rerunDiagnosis: (id: string) =>
    mutationOptions({
      mutationKey: ["curated", "incidents", id, "rerun-diagnosis"],
      mutationFn: () =>
        apiFetchPost<RerunDiagnosisResponse>(`/api/incidents/${encodeIncidentId(id)}/rerun-diagnosis`, {}),
    }),
};
