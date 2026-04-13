import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { ApiError, apiFetch, apiFetchPost, getStoredAuthToken } from "./client.js";
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

  diagnosisSettings: () =>
    queryOptions({
      queryKey: ["curated", "settings", "diagnosis"],
      queryFn: () => apiFetch<DiagnosisSettingsResponse>("/api/settings/diagnosis"),
      staleTime: 15_000,
      refetchInterval: useFixtures ? false : 15_000,
    }),
};

export interface EvidenceQueryRequest {
  question: string;
  isFollowup?: boolean;
  replyToClarification?: {
    originalQuestion: string;
    clarificationText: string;
  };
  clarificationChainLength?: number;
  history?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
}

export interface RerunDiagnosisResponse {
  status: "accepted";
}

export interface DiagnosisSettingsResponse {
  mode: "automatic" | "manual";
  provider?: "anthropic" | "openai" | "ollama" | "claude-code" | "codex";
  bridgeUrl: string;
}

export interface CloseIncidentResponse {
  status: "closed";
  closedAt: string;
}

async function triggerRerunDiagnosis(
  id: string,
  settings: DiagnosisSettingsResponse,
): Promise<RerunDiagnosisResponse> {
  if (settings.mode === "manual") {
    const response = await fetch(`${settings.bridgeUrl}/api/manual/diagnose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        incidentId: id,
        receiverUrl: window.location.origin,
        authToken: getStoredAuthToken() ?? undefined,
        provider: settings.provider,
      }),
    });
    if (!response.ok) {
      throw new ApiError(response.status, await response.text());
    }
    await response.json();
    return { status: "accepted" };
  }

  return apiFetchPost<RerunDiagnosisResponse>(`/api/incidents/${encodeIncidentId(id)}/rerun-diagnosis`, {});
}

async function triggerEvidenceQuery(
  id: string,
  body: EvidenceQueryRequest,
  _settings: DiagnosisSettingsResponse,
): Promise<EvidenceQueryResponse> {
  // Always use the receiver endpoint — it handles manual mode routing
  // internally (WS bridge or DO bridge) with pre-built diagnosisResult.
  return apiFetchPost<EvidenceQueryResponse>(`/api/incidents/${encodeIncidentId(id)}/evidence/query`, body);
}

export const curatedMutations = {
  evidenceQuery: (id: string, settings: DiagnosisSettingsResponse) =>
    mutationOptions({
      mutationKey: ["curated", "incidents", id, "evidence-query", settings.mode, settings.bridgeUrl],
      mutationFn: (body: EvidenceQueryRequest) => triggerEvidenceQuery(id, body, settings),
    }),

  rerunDiagnosis: (id: string, settings: DiagnosisSettingsResponse) =>
    mutationOptions({
      mutationKey: ["curated", "incidents", id, "rerun-diagnosis", settings.mode, settings.bridgeUrl],
      mutationFn: () => triggerRerunDiagnosis(id, settings),
    }),

  closeIncident: (id: string) =>
    mutationOptions({
      mutationKey: ["curated", "incidents", id, "close"],
      mutationFn: () =>
        apiFetchPost<CloseIncidentResponse>(`/api/incidents/${encodeIncidentId(id)}/close`, {}),
    }),
};
