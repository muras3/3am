import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "./client.js";
import type { Incident, IncidentPage } from "./types.js";

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
