import { queryOptions } from "@tanstack/react-query";
import { apiFetch, apiFetchPost } from "./client.js";
import { encodeIncidentId } from "../lib/incidentId.js";
import type {
  Incident,
  IncidentPage,
  RecentActivity,
  ServiceSurface,
} from "./types.js";

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
};

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
