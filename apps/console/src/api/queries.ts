import { queryOptions } from "@tanstack/react-query";
import { apiFetch, apiFetchPost } from "./client.js";
import type { Incident, IncidentPage } from "./types.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export async function sendChatMessage(
  incidentId: string,
  message: string,
  history: ChatTurn[],
): Promise<{ reply: string }> {
  return apiFetchPost<{ reply: string }>(`/api/chat/${incidentId}`, { message, history });
}

export const incidentQueries = {
  list: () =>
    queryOptions({
      queryKey: ["incidents"],
      queryFn: () => apiFetch<IncidentPage>("/api/incidents?limit=20"),
      staleTime: 30_000,
    }),

  detail: (id: string) =>
    queryOptions({
      queryKey: ["incidents", id],
      queryFn: () => apiFetch<Incident>(`/api/incidents/${id}`),
      staleTime: 15_000,
    }),
};
