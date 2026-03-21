import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  DiagnosisResultSchema,
  type DiagnosisResult,
  type RuntimeMapResponse as LegacyRuntimeMapResponse,
  type ExtendedIncident,
  type EvidenceResponse,
  type ClaimType,
  type HealthStatus,
} from "@3amoncall/core";
import type { RuntimeMapResponse as InternalRuntimeMapResponse } from "@3amoncall/core/schemas/runtime-map";
import type { IncidentDetailExtension } from "@3amoncall/core/schemas/incident-detail-extension";
import type { CuratedEvidenceResponse } from "@3amoncall/core/schemas/curated-evidence";
import { jwtCookieSetter, jwtCookieValidator } from "../middleware/session-cookie.js";
import { rateLimiter } from "../middleware/rate-limit.js";
import type { Incident, IncidentPage, StorageDriver } from "../storage/interface.js";
import { spanMembershipKey } from "../storage/interface.js";
import type { SpanBuffer } from "../ambient/span-buffer.js";
import type { TelemetryStoreDriver } from "../telemetry/interface.js";
import { buildIncidentQueryFilter } from "../telemetry/interface.js";
import { computeServices, computeActivity } from "../ambient/service-aggregator.js";
import { buildRuntimeMap } from "../ambient/runtime-map.js";
import { buildIncidentDetailExtension } from "../domain/incident-detail-extension.js";
import { buildCuratedEvidence } from "../domain/curated-evidence.js";

const CHAT_MAX_HISTORY = 10;
const CHAT_MAX_MESSAGE_CHARS = 500;
const CHAT_MAX_TOKENS = 512;
const CHAT_MODEL = process.env["CHAT_MODEL"] ?? "claude-haiku-4-5-20251001";

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

type IncidentResponse = Omit<Incident, "telemetryScope" | "spanMembership" | "anomalousSignals" | "platformEvents">;
type IncidentPageResponse = {
  items: IncidentResponse[];
  nextCursor?: string;
};

function toIncidentResponse(incident: Incident): IncidentResponse {
  const { telemetryScope: _ts, spanMembership: _sm, anomalousSignals: _as, platformEvents: _pe, ...response } = incident;
  return response;
}

function toIncidentPageResponse(page: IncidentPage): IncidentPageResponse {
  return {
    items: page.items.map(toIncidentResponse),
    nextCursor: page.nextCursor,
  };
}

function formatOpenedAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.max(0, Math.floor(diffMs / 60_000));
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.floor(diffHours / 24)}d`;
}

function inferConfidenceLabelAndValue(text: string): { label: string; value: number } {
  const lower = text.toLowerCase();
  if (lower.includes("high")) return { label: "High confidence", value: 0.85 };
  if (lower.includes("medium")) return { label: "Medium confidence", value: 0.6 };
  if (lower.includes("low")) return { label: "Low confidence", value: 0.35 };
  return { label: "Inferred confidence", value: 0.5 };
}

function chainTag(type: string): string {
  switch (type) {
    case "external":
      return "External Trigger";
    case "system":
      return "Design Gap";
    case "incident":
      return "Cascade";
    case "impact":
      return "User Impact";
    default:
      return "Observation";
  }
}

function mapSeverity(severity: Incident["packet"]["signalSeverity"]): string {
  return severity ?? "medium";
}

function mapRuntimeMapResponse(result: InternalRuntimeMapResponse): LegacyRuntimeMapResponse {
  return {
    summary: result.summary,
    nodes: result.nodes.map((node) => ({
      id: node.id,
      tier: node.tier,
      label: node.label,
      subtitle: node.subtitle,
      status: node.status,
      metrics: {
        errorRate: node.metrics.errorRate,
        p95Ms: node.metrics.p95Ms,
        reqPerSec: node.metrics.reqPerSec,
      },
      badges: node.metrics.errorRate > 0 ? [`${Math.round(node.metrics.errorRate * 100)}% err`] : [],
      incidentId: node.incidentId,
    })),
    edges: result.edges.map((edge) => ({
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      kind: edge.kind,
      status: edge.status,
      trafficHint: `${edge.requestCount}`,
    })),
    incidents: result.incidents.map((incident) => ({
      incidentId: incident.incidentId,
      label: incident.label,
      severity: incident.severity,
      openedAgo: formatOpenedAgo(incident.openedAt),
    })),
    state: {
      diagnosis: result.state.coverage === "cold_start" ? "unavailable" : "ready",
    },
  };
}

function mapExtendedIncident(
  incident: Incident,
  extension: IncidentDetailExtension,
): ExtendedIncident {
  const dr = incident.diagnosisResult;
  const severity = mapSeverity(incident.packet.signalSeverity);
  const confidence = inferConfidenceLabelAndValue(
    dr?.confidence.confidence_assessment ?? "medium confidence",
  );
  const basis =
    extension.confidencePrimitives.correlations[0] !== undefined
      ? `${extension.confidencePrimitives.correlations[0].metricName} on ${extension.confidencePrimitives.correlations[0].service} correlates ${extension.confidencePrimitives.correlations[0].correlationValue.toFixed(2)}`
      : dr?.confidence.confidence_assessment ?? "";

  const chips: ExtendedIncident["chips"] = [];
  const topBlast = extension.blastRadius[0];
  if (topBlast) {
    chips.push({ type: "critical", label: topBlast.displayValue });
  }
  const firstSignal = incident.anomalousSignals[0];
  if (firstSignal) {
    chips.push({
      type: firstSignal.signal.includes("429") ? "external" : "system",
      label: firstSignal.signal,
    });
  }
  const firstDependency = incident.packet.scope.affectedDependencies[0];
  if (firstDependency) {
    chips.push({ type: "system", label: firstDependency });
  }

  const blastRadius: ExtendedIncident["blastRadius"] = extension.blastRadius.map((entry) => ({
    target: entry.label,
    status: entry.status,
    impactValue: entry.impactValue,
    label: entry.displayValue,
  }));
  if (extension.blastRadiusRollup.healthyCount > 0) {
    blastRadius.push({
      target: extension.blastRadiusRollup.label,
      status: "healthy",
      impactValue: 0,
      label: "ok",
    });
  }

  return {
    incidentId: incident.incidentId,
    status: incident.status,
    severity,
    openedAt: incident.openedAt,
    closedAt: incident.closedAt,
    headline: dr?.summary.what_happened ?? "",
    chips,
    action: {
      text: dr?.recommendation.immediate_action ?? "",
      rationale: dr?.recommendation.action_rationale_short ?? "",
      doNot: dr?.recommendation.do_not ?? "",
    },
    rootCauseHypothesis: dr?.summary.root_cause_hypothesis ?? "",
    causalChain: dr?.reasoning.causal_chain.map((step) => ({
      type: step.type,
      tag: chainTag(step.type),
      title: step.title,
      detail: step.detail,
    })) ?? [],
    operatorChecks: dr?.operator_guidance.operator_checks ?? [],
    impactSummary: {
      startedAt: extension.impactSummary.startedAt,
      fullCascadeAt: extension.impactSummary.fullCascadeAt ?? "",
      diagnosedAt: extension.impactSummary.diagnosedAt ?? "",
    },
    blastRadius,
    confidenceSummary: {
      label: confidence.label,
      value: confidence.value,
      basis,
      risk: dr?.confidence.uncertainty ?? "",
    },
    evidenceSummary: {
      traces: extension.evidenceSummary.traces,
      traceErrors: extension.evidenceSummary.traceErrors,
      metrics: extension.evidenceSummary.metrics,
      logs: extension.evidenceSummary.logs,
      logErrors: extension.evidenceSummary.logErrors,
    },
    state: extension.state,
  };
}

function mapClaimType(metricClassOrKeyword: string): ClaimType {
  if (metricClassOrKeyword.includes("error") || metricClassOrKeyword.includes("rate")) {
    return "trigger";
  }
  if (metricClassOrKeyword.includes("latency") || metricClassOrKeyword.includes("timeout")) {
    return "cascade";
  }
  if (metricClassOrKeyword.includes("absence")) {
    return "absence";
  }
  return "recovery";
}

function mapLogSeverity(severity: string): "error" | "warn" | "info" {
  const upper = severity.toUpperCase();
  if (upper === "ERROR" || upper === "FATAL") return "error";
  if (upper === "WARN") return "warn";
  return "info";
}

function mapEvidenceResponse(result: CuratedEvidenceResponse): EvidenceResponse {
  return {
    proofCards: [],
    qa: null,
    sideNotes: [],
    surfaces: {
      traces: {
        observed: result.surfaces.traces.observed.map((trace) => ({
          traceId: trace.traceId,
          route: trace.rootSpanName,
          status: trace.httpStatusCode ?? (trace.status === "error" ? 500 : 200),
          durationMs: trace.durationMs,
          spans: trace.spans.map((span) => ({
            spanId: span.spanId,
            name: span.spanName,
            durationMs: span.durationMs,
            status: span.status,
            attributes: span.attributes,
          })),
        })),
        expected: result.surfaces.traces.expected.map((trace) => ({
          traceId: trace.traceId,
          route: trace.rootSpanName,
          status: trace.httpStatusCode ?? 200,
          durationMs: trace.durationMs,
          spans: trace.spans.map((span) => ({
            spanId: span.spanId,
            name: span.spanName,
            durationMs: span.durationMs,
            status: span.status,
            attributes: span.attributes,
          })),
        })),
        smokingGunSpanId: result.surfaces.traces.smokingGunSpanId ?? null,
      },
      metrics: {
        hypotheses: result.surfaces.metrics.groups.map((group) => ({
          id: group.groupId,
          type: mapClaimType(group.groupKey.metricClass),
          claim: group.diagnosisLabel ?? `${group.groupKey.service} ${group.groupKey.metricClass}`,
          verdict: group.diagnosisVerdict === "Confirmed" ? "Confirmed" : "Inferred",
          metrics: group.rows.map((row) => ({
            name: row.name,
            value: String(row.observedValue),
            expected: String(row.expectedValue),
            barPercent: Math.round(row.impactBar * 100),
          })),
        })),
      },
      logs: {
        claims: [
          ...result.surfaces.logs.clusters.map((cluster) => ({
            id: cluster.clusterId,
            type: mapClaimType(cluster.clusterKey.keywordHits.join(",")),
            label: cluster.diagnosisLabel ?? `${cluster.clusterKey.primaryService} ${cluster.clusterKey.severityDominant.toLowerCase()} logs`,
            count: cluster.entries.length,
            entries: cluster.entries.map((entry) => ({
              timestamp: entry.timestamp,
              severity: mapLogSeverity(entry.severity),
              body: entry.body,
              signal: entry.isSignal,
            })),
          })),
          ...result.surfaces.logs.absenceEvidence.map((absence) => ({
            id: absence.patternId,
            type: "absence" as const,
            label: absence.diagnosisLabel ?? absence.defaultLabel,
            count: 0,
            entries: [],
          })),
        ],
      },
    },
    state: result.state,
  };
}

function buildChatSystemPrompt(dr: DiagnosisResult): string {
  const chain = dr.reasoning.causal_chain.map((s) => s.title).join(" → ");
  return (
    "You are an incident responder assistant. The engineer is investigating an active incident.\n\n" +
    `Incident summary: ${dr.summary.what_happened}\n` +
    `Root cause: ${dr.summary.root_cause_hypothesis}\n` +
    `Recommended action: ${dr.recommendation.immediate_action}\n` +
    `Causal chain: ${chain}\n\n` +
    "Answer concisely in 1-3 sentences. Do not speculate beyond the provided context."
  );
}

function validateChatBody(body: unknown): { message: string; history: ChatTurn[] } | string {
  if (typeof body !== "object" || body === null) return "invalid body";
  const b = body as Record<string, unknown>;

  const message = b["message"];
  if (typeof message !== "string" || message.trim().length === 0) return "message is required";
  if (message.length > CHAT_MAX_MESSAGE_CHARS) {
    return `message must be at most ${CHAT_MAX_MESSAGE_CHARS} characters`;
  }

  const history = b["history"] ?? [];
  if (!Array.isArray(history)) return "history must be an array";
  if (history.length > CHAT_MAX_HISTORY) {
    return `history exceeds maximum of ${CHAT_MAX_HISTORY} turns`;
  }
  for (const turn of history as unknown[]) {
    if (
      typeof turn !== "object" ||
      turn === null ||
      !["user", "assistant"].includes((turn as Record<string, unknown>)["role"] as string) ||
      typeof (turn as Record<string, unknown>)["content"] !== "string"
    ) {
      return "invalid history entry";
    }
  }

  return { message, history: history as ChatTurn[] };
}

// Body size limits per route group (B-13).
// Applied per-route (not wildcard) because Hono runs all matching middleware —
// a restrictive wildcard would block routes that need a higher limit.
// Future POST routes should use apiBodyLimit(64 * 1024) as the default.
const apiBodyLimit = (maxSize: number) =>
  bodyLimit({ maxSize, onError: (c) => c.json({ error: "payload too large" }, 413) });

export function createApiRouter(storage: StorageDriver, spanBuffer: SpanBuffer | undefined, telemetryStore: TelemetryStoreDriver): Hono {
  const app = new Hono();

  // JWT session cookie for chat endpoint (B-11)
  // Cookie is set on all /api/* responses; validated only on /api/chat/*.
  // Active only when RECEIVER_AUTH_TOKEN is set (production).
  const authToken = process.env["RECEIVER_AUTH_TOKEN"];
  const allowInsecure = process.env["ALLOW_INSECURE_DEV_MODE"] === "true";
  if (authToken) {
    app.use("/api/*", jwtCookieSetter({ authToken, secure: !allowInsecure }));
    app.use("/api/chat/*", jwtCookieValidator(authToken));
  }

  // Rate limit chat endpoint — LLM cost protection (B-11)
  app.use("/api/chat/*", rateLimiter({ windowMs: 60_000, max: 10 }));

  app.get("/api/incidents", async (c) => {
    const limitStr = c.req.query("limit");
    const cursor = c.req.query("cursor");
    const rawLimit = limitStr !== undefined ? parseInt(limitStr, 10) : 20;
    const limit = Number.isNaN(rawLimit) ? 20 : Math.min(Math.max(rawLimit, 1), 100);

    const page = await storage.listIncidents({ limit, cursor });
    return c.json(toIncidentPageResponse(page));
  });

  app.get("/api/incidents/:id", async (c) => {
    const id = c.req.param("id");
    const incident = await storage.getIncident(id);
    if (incident === null) {
      return c.json({ error: "not found" }, 404);
    }
    const base = toIncidentResponse(incident);
    const extension = await buildIncidentDetailExtension(incident, telemetryStore);
    return c.json({
      ...base,
      ...mapExtendedIncident(incident, extension),
    });
  });

  app.get("/api/incidents/:id/evidence", async (c) => {
    const id = c.req.param("id");
    const incident = await storage.getIncident(id);
    if (incident === null) {
      return c.json({ error: "not found" }, 404);
    }
    const result = await buildCuratedEvidence(incident, telemetryStore);
    return c.json(mapEvidenceResponse(result));
  });

  app.get("/api/packets/:packetId", async (c) => {
    const packetId = c.req.param("packetId");
    const incident = await storage.getIncidentByPacketId(packetId);
    if (!incident) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(incident.packet);
  });

  app.post("/api/diagnosis/:id", apiBodyLimit(512 * 1024), async (c) => {
    const id = c.req.param("id");

    let result: DiagnosisResult;
    try {
      const body = await c.req.json();
      result = DiagnosisResultSchema.parse(body);
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }

    if (result.metadata.incident_id !== id) {
      return c.json(
        { error: "metadata.incident_id does not match path param" },
        400,
      );
    }

    const incident = await storage.getIncident(id);
    if (incident === null) {
      return c.json({ error: "not found" }, 404);
    }

    await storage.appendDiagnosis(id, result);
    return c.json({ status: "ok" });
  });

  app.post("/api/chat/:id", apiBodyLimit(1 * 1024), async (c) => {
    const id = c.req.param("id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }

    const validated = validateChatBody(body);
    if (typeof validated === "string") {
      const status = validated.startsWith("history exceeds") ? 422 : 400;
      return c.json({ error: validated }, status);
    }
    const { message, history } = validated;

    const incident = await storage.getIncident(id);
    if (incident === null) return c.json({ error: "not found" }, 404);
    if (!incident.diagnosisResult) {
      return c.json({ error: "diagnosis not yet available for this incident" }, 404);
    }

    const systemPrompt = buildChatSystemPrompt(incident.diagnosisResult);
    const sandboxedMessage = `<user_message>${message}</user_message>`;

    const messages: Anthropic.MessageParam[] = [
      ...history.map((t) => ({ role: t.role, content: t.content })),
      { role: "user", content: sandboxedMessage },
    ];

    // Explicit config so tests can override via ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY env vars
    // without relying on implicit SDK env scanning.
    const client = new Anthropic({
      baseURL: process.env["ANTHROPIC_BASE_URL"],
      apiKey: process.env["ANTHROPIC_API_KEY"] ?? "no-key",
    });
    const response = await client.messages.create({
      model: CHAT_MODEL,
      max_tokens: CHAT_MAX_TOKENS,
      temperature: 0.3,
      system: systemPrompt,
      messages,
    });

    const reply = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return c.json({ reply });
  });

  // ── Ambient read-model routes (ADR 0029) ─────────────────────────────────────

  app.get("/api/runtime-map", async (c) => {
    const windowStr = c.req.query("windowMinutes");
    const windowMinutes = windowStr !== undefined ? parseInt(windowStr, 10) : undefined;
    const validWindow = windowMinutes !== undefined && !Number.isNaN(windowMinutes) && windowMinutes > 0
      ? windowMinutes : undefined;
    const result = await buildRuntimeMap(telemetryStore, storage, validWindow);
    return c.json(mapRuntimeMapResponse(result));
  });

  app.get("/api/services", (c) => {
    if (!spanBuffer) return c.json([]);
    return c.json(computeServices(spanBuffer.getAll(), Date.now()));
  });

  app.get("/api/activity", (c) => {
    if (!spanBuffer) return c.json([]);
    const limitStr = c.req.query("limit");
    const rawLimit = limitStr !== undefined ? parseInt(limitStr, 10) : 20;
    const limit = Number.isNaN(rawLimit) ? 20 : Math.min(Math.max(rawLimit, 1), 100);
    return c.json(computeActivity(spanBuffer.getAll(), limit));
  });

  // ── Telemetry API endpoints (ADR 0032 Step F) ────────────────────────────────

  app.get("/api/incidents/:id/telemetry/spans", async (c) => {
    const id = c.req.param("id");
    const incident = await storage.getIncident(id);
    if (incident === null) {
      return c.json({ error: "not found" }, 404);
    }

    const { telemetryScope, spanMembership } = incident;
    if (telemetryScope.windowStartMs >= telemetryScope.windowEndMs) {
      return c.json([]);
    }

    const filter = buildIncidentQueryFilter(telemetryScope);
    const spans = await telemetryStore.querySpans(filter);
    // Filter by spanMembership — only return incident-bound spans
    const membershipSet = new Set(spanMembership);
    const memberSpans = spans.filter(s => membershipSet.has(spanMembershipKey(s.traceId, s.spanId)));
    return c.json(memberSpans);
  });

  app.get("/api/incidents/:id/telemetry/metrics", async (c) => {
    const id = c.req.param("id");
    const incident = await storage.getIncident(id);
    if (incident === null) {
      return c.json({ error: "not found" }, 404);
    }

    const { telemetryScope } = incident;
    if (telemetryScope.windowStartMs >= telemetryScope.windowEndMs) {
      return c.json([]);
    }

    const filter = buildIncidentQueryFilter(telemetryScope);
    const metrics = await telemetryStore.queryMetrics(filter);
    return c.json(metrics);
  });

  app.get("/api/incidents/:id/telemetry/logs", async (c) => {
    const id = c.req.param("id");
    const incident = await storage.getIncident(id);
    if (incident === null) {
      return c.json({ error: "not found" }, 404);
    }

    const { telemetryScope, spanMembership } = incident;
    if (telemetryScope.windowStartMs >= telemetryScope.windowEndMs) {
      return c.json({ correlated: [], contextual: [] });
    }

    const filter = buildIncidentQueryFilter(telemetryScope);
    const logs = await telemetryStore.queryLogs(filter);

    // Build trace set from spanMembership for correlation
    const memberTraceIds = new Set(spanMembership.map(ref => ref.split(":")[0]));

    // Split logs into correlated (traceId matches spanMembership traces) and contextual
    const correlated = logs.filter(l => l.traceId !== undefined && memberTraceIds.has(l.traceId));
    const contextual = logs.filter(l => l.traceId === undefined || !memberTraceIds.has(l.traceId));

    return c.json({ correlated, contextual });
  });

  return app;
}
