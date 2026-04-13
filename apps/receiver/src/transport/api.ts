import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  ConsoleNarrativeSchema,
  DiagnosisResultSchema,
  EvidenceQueryRequestSchema,
  ReasoningStructureSchema,
  type DiagnosisResult,
} from "3am-core";
import { callModelMessages, wrapUserMessage } from "3am-diagnosis";
import { issueSessionCookie } from "../middleware/session-cookie.js";
import { rateLimiter } from "../middleware/rate-limit.js";
import type { Incident, IncidentPage, StorageDriver } from "../storage/interface.js";
import { spanMembershipKey } from "../storage/interface.js";
import type { SpanBuffer } from "../ambient/span-buffer.js";
import type { BufferedSpan } from "../ambient/types.js";
import type { TelemetryStoreDriver } from "../telemetry/interface.js";
import {
  MAX_QUERY_LOGS,
  MAX_QUERY_METRICS,
  MAX_QUERY_SPANS,
  buildIncidentQueryFilter,
  type TelemetrySpan,
} from "../telemetry/interface.js";
import { computeServices, computeActivity } from "../ambient/service-aggregator.js";
import { buildRuntimeMap } from "../ambient/runtime-map.js";
import { buildExtendedIncident } from "../domain/incident-detail-extension.js";
import { buildCuratedEvidence } from "../domain/curated-evidence.js";
import { buildEvidenceQueryAnswer } from "../domain/evidence-query.js";
import { buildReasoningStructure } from "../domain/reasoning-structure-builder.js";
import type { DiagnosisRunner } from "../runtime/diagnosis-runner.js";
import { resolveWaitUntil, runClaimedDiagnosis } from "../runtime/diagnosis-debouncer.js";
import type { DiagnosisConfig } from "../runtime/diagnosis-debouncer.js";
import type { EnqueueDiagnosisFn } from "../runtime/diagnosis-dispatch.js";
import { ensureIncidentMaterialized } from "../runtime/materialization.js";
import { getReceiverLlmSettings } from "../runtime/llm-settings.js";
import { maybeCleanup } from "../retention/lazy-cleanup.js";
import type { WsBridgeManager } from "./ws-bridge.js";
import type { BridgeRequest, BridgeResponse } from "./ws-bridge.js";

/**
 * Function that forwards a bridge request through a Durable Object.
 * Used on CF Workers where the WS connection lives in a DO, not in-memory.
 * Returns the BridgeResponse from the DO, or throws on failure.
 */
export type BridgeDoForwarder = (request: BridgeRequest) => Promise<BridgeResponse>;

const CHAT_MAX_HISTORY = 10;
const CHAT_MAX_MESSAGE_CHARS = 500;
const CHAT_MAX_TOKENS = 512;
const CHAT_MODEL = process.env["CHAT_MODEL"] ?? "claude-haiku-4-5-20251001";

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

type IncidentResponse = Omit<Incident, "telemetryScope" | "spanMembership" | "anomalousSignals" | "platformEvents" | "packet" | "consoleNarrative" | "diagnosisResult">;
type IncidentPageResponse = {
  items: IncidentResponse[];
  nextCursor?: string;
};

type TelemetryPageResponse<T> = {
  items: T[];
  nextCursor?: string;
};

type TelemetryLogsPageResponse<T> = {
  correlated: TelemetryPageResponse<T>;
  contextual: TelemetryPageResponse<T>;
};

type ManualChatBridgeResponse = {
  reply: string;
};

const TELEMETRY_SPANS_DEFAULT_LIMIT = 100;
const TELEMETRY_METRICS_DEFAULT_LIMIT = 50;
const TELEMETRY_LOGS_CORRELATED_DEFAULT_LIMIT = 100;
const TELEMETRY_LOGS_CONTEXTUAL_DEFAULT_LIMIT = 50;
const TELEMETRY_MAX_LIMIT = 200;
const AMBIENT_LIVE_WINDOW_MS = 5 * 60 * 1000;
const AMBIENT_INCIDENT_FALLBACK_LIMIT = 50;
const CLAIM_KEY_PREFIX = "claim:";
const SETUP_COMPLETE_SETTINGS_KEY = "setup_complete";
const CLAIM_TTL_MS = 10 * 60 * 1000;

function toIncidentResponse(incident: Incident): IncidentResponse {
  const { telemetryScope: _ts, spanMembership: _sm, anomalousSignals: _as, platformEvents: _pe, packet: _pk, consoleNarrative: _cn, diagnosisResult: _dr, ...response } = incident;
  return response;
}

function toIncidentPageResponse(page: IncidentPage): IncidentPageResponse {
  return {
    items: page.items.map(toIncidentResponse),
    nextCursor: page.nextCursor,
  };
}

function parseCursor(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

function parseLimit(raw: string | undefined, defaultLimit: number): number {
  if (raw === undefined) return defaultLimit;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return defaultLimit;
  return Math.min(Math.max(parsed, 1), TELEMETRY_MAX_LIMIT);
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

function paginateItems<T>(
  items: T[],
  limit: number,
  cursor?: string,
): TelemetryPageResponse<T> {
  const offset = parseCursor(cursor);
  const pagedItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pagedItems.length;
  return {
    items: pagedItems,
    nextCursor: nextOffset < items.length ? String(nextOffset) : undefined,
  };
}

function boundedQueryLimit(cursor: string | undefined, limit: number, hardCap: number): number {
  return Math.min(parseCursor(cursor) + limit + 1, hardCap);
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

function buildRemoteLoopbackBridgeError(receiverOrigin: string, bridgeUrl: string): string {
  const platformHint = receiverOrigin.includes("vercel.app")
    ? " Vercel Functions do not expose the /bridge/ws upgrade path used by the local bridge client."
    : "";
  return (
    `remote receiver ${receiverOrigin} cannot reach loopback bridge URL ${bridgeUrl}.` +
    `${platformHint} Set LLM_BRIDGE_URL to a public bridge endpoint reachable from the receiver runtime, or switch manual mode to a supported relay runtime.`
  );
}

function telemetrySpanToBufferedSpan(span: TelemetrySpan): BufferedSpan {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    serviceName: span.serviceName,
    environment: span.environment,
    httpRoute: span.httpRoute,
    httpStatusCode: span.httpStatusCode,
    spanStatusCode: span.spanStatusCode,
    spanKind: span.spanKind,
    durationMs: span.durationMs,
    startTimeMs: span.startTimeMs,
    exceptionCount: span.exceptionCount,
    peerService: span.peerService,
    spanName: span.spanName,
    httpMethod: span.httpMethod,
    attributes: span.attributes,
    ingestedAt: span.ingestedAt,
  };
}

async function loadAmbientSpans(
  spanBuffer: SpanBuffer | undefined,
  telemetryStore: TelemetryStoreDriver,
  storage: StorageDriver,
): Promise<BufferedSpan[]> {
  const liveSpans = spanBuffer?.getAll() ?? [];
  if (liveSpans.length > 0) return liveSpans;

  const now = Date.now();
  const recentSpans = await telemetryStore.querySpans({
    startMs: now - AMBIENT_LIVE_WINDOW_MS,
    endMs: now,
    limit: MAX_QUERY_SPANS,
    orderBy: "startTimeDesc",
  });
  if (recentSpans.length > 0) {
    return recentSpans.map(telemetrySpanToBufferedSpan);
  }

  const openIncidents = (await storage.listIncidents({ limit: AMBIENT_INCIDENT_FALLBACK_LIMIT })).items
    .filter((incident) => incident.status === "open");
  if (openIncidents.length === 0) return [];

  const preservedSpans = new Map<string, BufferedSpan>();
  for (const incident of openIncidents) {
    if (incident.telemetryScope.windowStartMs >= incident.telemetryScope.windowEndMs) continue;

    const scopedSpans = await telemetryStore.querySpans({
      ...buildIncidentQueryFilter(incident.telemetryScope),
      limit: MAX_QUERY_SPANS,
      orderBy: "startTimeDesc",
    });
    const membership = new Set(incident.spanMembership);
    const matchedSpans = membership.size > 0
      ? scopedSpans.filter((span) => membership.has(spanMembershipKey(span.traceId, span.spanId)))
      : scopedSpans;

    for (const span of matchedSpans) {
      preservedSpans.set(`${span.traceId}:${span.spanId}`, telemetrySpanToBufferedSpan(span));
    }
  }

  return Array.from(preservedSpans.values());
}

function buildChatSystemPrompt(dr: DiagnosisResult, locale?: "en" | "ja"): string {
  const chain = dr.reasoning.causal_chain.map((s) => s.title).join(" → ");
  const jaInstruction = locale === "ja"
    ? "\n\nRespond in Japanese. Use concise, operator-actionable language."
    : "";
  return (
    "You are an incident responder assistant. The engineer is investigating an active incident.\n\n" +
    `Incident summary: ${dr.summary.what_happened}\n` +
    `Root cause: ${dr.summary.root_cause_hypothesis}\n` +
    `Recommended action: ${dr.recommendation.immediate_action}\n` +
    `Causal chain: ${chain}\n` +
    `Confidence: ${dr.confidence.confidence_assessment}\n` +
    `Known uncertainty: ${dr.confidence.uncertainty}\n\n` +
    "Answer concisely in 1-3 sentences. Prioritize facts from the provided diagnosis. " +
    "You may make limited, reasonable inferences only when they are directly supported by the diagnosis summary, " +
    "root-cause hypothesis, recommendation, or causal chain. If you infer anything, explicitly label it as a " +
    "hypothesis or inference instead of a confirmed fact. Do not invent new evidence, timelines, or remediation " +
    "steps. If the question needs evidence beyond the diagnosis, say what should be checked next." +
    jaInstruction
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

export function createApiRouter(
  storage: StorageDriver,
  spanBuffer: SpanBuffer | undefined,
  telemetryStore: TelemetryStoreDriver,
  diagnosisConfig: DiagnosisConfig,
  diagnosisRunner?: DiagnosisRunner,
  enqueueDiagnosis?: EnqueueDiagnosisFn,
  wsBridge?: WsBridgeManager,
  bridgeDoForwarder?: BridgeDoForwarder,
): Hono {
  const app = new Hono();

  // JWT session cookie for browser clients.
  const authToken = process.env["RECEIVER_AUTH_TOKEN"];
  const allowInsecure = process.env["ALLOW_INSECURE_DEV_MODE"] === "true";

  // Rate limit chat endpoint — LLM cost protection (B-11)
  app.use("/api/chat/*", rateLimiter({ windowMs: 60_000, max: 10, storage }));

  // Rate limit evidence query endpoint — LLM cost protection
  app.use("/api/incidents/*/evidence/query", rateLimiter({ windowMs: 60_000, max: 10, storage }));

  app.post("/api/claims", apiBodyLimit(4 * 1024), async (c) => {
    if (!authToken) {
      return c.json({ error: "claims unavailable in insecure dev mode" }, 404);
    }

    // Validate Bearer token — only the holder of the receiver auth token may mint claims.
    const authHeader = c.req.header("Authorization");
    if (!authHeader || authHeader !== `Bearer ${authToken}`) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = base64UrlEncode(tokenBytes);
    const expiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();
    const tokenHash = await sha256(token);

    // Store under a per-claim key so multiple pending claims can coexist.
    // A new mint no longer invalidates a previously issued sign-in link.
    await storage.setSettings(
      CLAIM_KEY_PREFIX + tokenHash,
      JSON.stringify({ expiresAt }),
    );

    return c.json({ token, expiresAt });
  });

  app.post("/api/claims/exchange", apiBodyLimit(4 * 1024), async (c) => {
    if (!authToken) {
      return c.json({ error: "claims unavailable in insecure dev mode" }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    const token = typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)["token"]
      : undefined;
    if (typeof token !== "string" || token.length < 16) {
      return c.json({ error: "invalid token" }, 400);
    }

    // Hash the token first so we can look up the per-claim storage key.
    const tokenHash = await sha256(token);
    const claimKey = CLAIM_KEY_PREFIX + tokenHash;

    const rawState = await storage.getSettings(claimKey);
    if (!rawState) {
      return c.json({ error: "claim unavailable" }, 404);
    }

    let claimState: { expiresAt: string };
    try {
      claimState = JSON.parse(rawState) as { expiresAt: string };
    } catch {
      return c.json({ error: "claim unavailable" }, 404);
    }

    if (Date.parse(claimState.expiresAt) <= Date.now()) {
      await storage.setSettings(claimKey, "");
      return c.json({ error: "claim expired" }, 410);
    }

    await storage.setSettings(claimKey, "");
    await storage.setSettings(SETUP_COMPLETE_SETTINGS_KEY, "true");
    await issueSessionCookie(c, { authToken, secure: !allowInsecure });
    return c.json({ status: "ok" });
  });

  app.get("/api/incidents", async (c) => {
    await maybeCleanup(storage, telemetryStore);
    const limitStr = c.req.query("limit");
    const cursor = c.req.query("cursor");
    const rawLimit = limitStr !== undefined ? parseInt(limitStr, 10) : 20;
    const limit = Number.isNaN(rawLimit) ? 20 : Math.min(Math.max(rawLimit, 1), 100);

    const page = await storage.listIncidents({ limit, cursor });
    return c.json(toIncidentPageResponse(page));
  });

  app.get("/api/incidents/:id", async (c) => {
    await maybeCleanup(storage, telemetryStore);
    const id = c.req.param("id");
    // Ensure snapshots are fresh before building extended incident
    await ensureIncidentMaterialized(id, storage, telemetryStore, diagnosisConfig, diagnosisRunner, enqueueDiagnosis);
    const incident = await storage.getIncident(id);
    if (incident === null) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(await buildExtendedIncident(incident, telemetryStore));
  });

  app.get("/api/incidents/:id/packet", async (c) => {
    const id = c.req.param("id");
    await ensureIncidentMaterialized(id, storage, telemetryStore, diagnosisConfig, diagnosisRunner, enqueueDiagnosis);
    const incident = await storage.getIncident(id);
    if (incident === null) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(incident.packet);
  });

  app.get("/api/incidents/:id/reasoning-structure", async (c) => {
    const id = c.req.param("id");
    const incident = await storage.getIncident(id);
    if (incident === null) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(ReasoningStructureSchema.parse(await buildReasoningStructure(incident, telemetryStore)));
  });

  app.get("/api/incidents/:id/evidence", async (c) => {
    await maybeCleanup(storage, telemetryStore);
    const id = c.req.param("id");
    const incident = await storage.getIncident(id);
    if (incident === null) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(await buildCuratedEvidence(incident, telemetryStore));
  });

  app.post("/api/incidents/:id/close", apiBodyLimit(4 * 1024), async (c) => {
    const id = c.req.param("id");

    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "invalid body" }, 400);
    }
    if ((body as Record<string, unknown>)["reason"] !== undefined && typeof (body as Record<string, unknown>)["reason"] !== "string") {
      return c.json({ error: "invalid body" }, 400);
    }
    const incident = await storage.getIncident(id);
    if (incident === null) {
      return c.json({ error: "not found" }, 404);
    }
    if (incident.status !== "closed") {
      await storage.updateIncidentStatus(id, "closed");
    }

    const updated = await storage.getIncident(id);
    return c.json({
      status: "closed",
      closedAt: updated?.closedAt ?? new Date().toISOString(),
    });
  });

  if (diagnosisRunner) {
    app.post("/api/incidents/:id/rerun-diagnosis", async (c) => {
      const id = c.req.param("id");
      const incident = await storage.getIncident(id);
      if (incident === null) {
        return c.json({ error: "not found" }, 404);
      }

      if (enqueueDiagnosis) {
        const mode = incident.diagnosisResult && !incident.consoleNarrative
          ? "narrative"
          : "diagnosis";
        await storage.markDiagnosisScheduled(id);
        await enqueueDiagnosis(id, mode);
        return c.json({ status: "accepted" }, 202);
      }

      const claimed = await storage.claimDiagnosisDispatch(id);
      if (!claimed) {
        return c.json({ error: "already_running" }, 409);
      }

      await storage.markDiagnosisScheduled(id);
      const waitUntil = await resolveWaitUntil();
      waitUntil((async () => {
        try {
          await runClaimedDiagnosis(id, storage, diagnosisRunner);
        } catch (error) {
          console.error(`[api] rerun diagnosis failed for ${id}:`, error);
        }
      })());
      return c.json({ status: "accepted" }, 202);
    });
  }

  app.post("/api/incidents/:id/evidence/query", apiBodyLimit(4 * 1024), async (c) => {
    const id = c.req.param("id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }

    const parsed = EvidenceQueryRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.issues }, 400);
    }

    const incident = await storage.getIncident(id);
    if (incident === null) {
      return c.json({ error: "not found" }, 404);
    }

    const storedLocale = await storage.getSettings("locale");
    const locale: "en" | "ja" = parsed.data.locale ?? (storedLocale === "ja" ? "ja" : "en");

    // In manual mode, route evidence query through bridge (LLM-powered).
    // Pre-build diagnosisResult + evidence so bridge doesn't need to re-fetch.
    const llmSettings = await getReceiverLlmSettings(storage);
    if (llmSettings.mode === "manual") {
      if (!incident.diagnosisResult) {
        return c.json({ error: "diagnosis not yet available for this incident" }, 404);
      }
      const evidence = await buildCuratedEvidence(incident, telemetryStore);

      if (wsBridge?.isConnected()) {
        try {
          const wsResult = await wsBridge.evidenceQuery({
            incidentId: id,
            receiverUrl: new URL(c.req.url).origin,
            authToken,
            question: parsed.data.question,
            history: parsed.data.history ?? [],
            provider: llmSettings.provider,
            diagnosisResult: incident.diagnosisResult,
            evidence,
            locale,
            isSystemFollowup: parsed.data.isSystemFollowup ?? false,
          });
          return c.json(wsResult.result);
        } catch (error) {
          return c.json({
            error: "manual evidence query bridge failed",
            details: error instanceof Error ? error.message : String(error),
          }, 502);
        }
      }

      // CF Workers: route through Durable Object bridge
      if (bridgeDoForwarder) {
        try {
          const doResponse = await bridgeDoForwarder({
            type: "evidence_query_request",
            id: "", // will be assigned by the DO
            incidentId: id,
            receiverUrl: new URL(c.req.url).origin,
            authToken,
            question: parsed.data.question,
            history: parsed.data.history ?? [],
            provider: llmSettings.provider,
            diagnosisResult: incident.diagnosisResult,
            evidence,
            locale,
            isSystemFollowup: parsed.data.isSystemFollowup ?? false,
          });
          if (doResponse.type === "error_response") {
            return c.json({
              error: "manual evidence query bridge failed",
              details: doResponse.error,
            }, 502);
          }
          if (doResponse.type === "evidence_query_response") {
            return c.json(doResponse.result);
          }
          return c.json({
            error: "manual evidence query bridge failed",
            details: `unexpected response type: ${doResponse.type}`,
          }, 502);
        } catch (error) {
          return c.json({
            error: "manual evidence query bridge failed",
            details: error instanceof Error ? error.message : String(error),
          }, 502);
        }
      }

      // Fall back to HTTP proxy (only works when bridge is on localhost)
      const receiverOrigin = new URL(c.req.url).origin;
      if (isLoopbackUrl(llmSettings.bridgeUrl) && !isLoopbackUrl(receiverOrigin)) {
        return c.json({
          error: "manual evidence query bridge unavailable",
          details: buildRemoteLoopbackBridgeError(receiverOrigin, llmSettings.bridgeUrl),
        }, 503);
      }

      try {
        const bridgeResponse = await fetch(`${llmSettings.bridgeUrl}/api/manual/evidence-query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            receiverUrl: receiverOrigin,
            incidentId: id,
            authToken,
            question: parsed.data.question,
            history: parsed.data.history ?? [],
            provider: llmSettings.provider,
            diagnosisResult: incident.diagnosisResult,
            evidence,
            locale,
            isSystemFollowup: parsed.data.isSystemFollowup ?? false,
          }),
        });
        if (!bridgeResponse.ok) {
          const bodyText = await bridgeResponse.text();
          return c.json({
            error: "manual evidence query bridge failed",
            details: bodyText || `bridge returned HTTP ${bridgeResponse.status}`,
          }, 502);
        }
        return c.json(await bridgeResponse.json());
      } catch (error) {
        return c.json({
          error: "manual evidence query bridge unavailable",
          details: error instanceof Error ? error.message : String(error),
        }, 502);
      }
    }

    // Automatic evidence queries can still return status="answered" without a live
    // bridge because buildEvidenceQueryAnswer() has deterministic curated-evidence
    // fallbacks when the planner/generator model layer is unavailable.
    const result = await buildEvidenceQueryAnswer(
      incident,
      telemetryStore,
      parsed.data.question,
      parsed.data.isFollowup ?? false,
      locale,
      parsed.data.history ?? [],
      parsed.data.isSystemFollowup ?? false,
    );
    return c.json(result);
  });

  app.get("/api/packets/:packetId", async (c) => {
    const packetId = c.req.param("packetId");
    const incident = await storage.getIncidentByPacketId(packetId);
    if (!incident) {
      return c.json({ error: "not found" }, 404);
    }
    await ensureIncidentMaterialized(incident.incidentId, storage, telemetryStore, diagnosisConfig, diagnosisRunner, enqueueDiagnosis);
    const refreshed = await storage.getIncident(incident.incidentId);
    return c.json(refreshed?.packet ?? incident.packet);
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
    await storage.releaseDiagnosisDispatch(id);
    return c.json({ status: "ok" });
  });

  app.post("/api/incidents/:id/console-narrative", apiBodyLimit(512 * 1024), async (c) => {
    const id = c.req.param("id");

    let result;
    try {
      result = ConsoleNarrativeSchema.parse(await c.req.json());
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }

    const incident = await storage.getIncident(id);
    if (incident === null) {
      return c.json({ error: "not found" }, 404);
    }

    await storage.appendConsoleNarrative(id, result);
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

    const storedLocale = await storage.getSettings("locale");
    const locale: "en" | "ja" = storedLocale === "ja" ? "ja" : "en";
    const systemPrompt = buildChatSystemPrompt(incident.diagnosisResult, locale);
    const sandboxedMessage = wrapUserMessage(message);

    const llmSettings = await getReceiverLlmSettings(storage);
    if (llmSettings.mode === "manual") {
      // Prefer WebSocket bridge if connected (Node.js/Vercel: in-memory WsBridgeManager)
      if (wsBridge?.isConnected()) {
        try {
          const wsResult = await wsBridge.chat({
            incidentId: id,
            receiverUrl: new URL(c.req.url).origin,
            authToken,
            message,
            history,
            provider: llmSettings.provider,
            systemPrompt,
          });
          return c.json(wsResult);
        } catch (error) {
          return c.json({
            error: "manual chat bridge failed",
            details: error instanceof Error ? error.message : String(error),
          }, 502);
        }
      }

      // CF Workers: route through Durable Object bridge
      if (bridgeDoForwarder) {
        try {
          const doResponse = await bridgeDoForwarder({
            type: "chat_request",
            id: "", // will be assigned by the DO
            incidentId: id,
            receiverUrl: new URL(c.req.url).origin,
            authToken,
            message,
            history,
            provider: llmSettings.provider,
            systemPrompt,
          });
          if (doResponse.type === "error_response") {
            return c.json({
              error: "manual chat bridge failed",
              details: doResponse.error,
            }, 502);
          }
          if (doResponse.type === "chat_response") {
            return c.json({ reply: doResponse.reply });
          }
          return c.json({
            error: "manual chat bridge failed",
            details: `unexpected response type: ${doResponse.type}`,
          }, 502);
        } catch (error) {
          return c.json({
            error: "manual chat bridge failed",
            details: error instanceof Error ? error.message : String(error),
          }, 502);
        }
      }

      // Fall back to HTTP proxy (only works when bridge is on localhost)
      const receiverOrigin = new URL(c.req.url).origin;
      if (isLoopbackUrl(llmSettings.bridgeUrl) && !isLoopbackUrl(receiverOrigin)) {
        return c.json({
          error: "manual chat bridge unavailable",
          details: buildRemoteLoopbackBridgeError(receiverOrigin, llmSettings.bridgeUrl),
        }, 503);
      }

      try {
        const bridgeResponse = await fetch(`${llmSettings.bridgeUrl}/api/manual/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            receiverUrl: receiverOrigin,
            incidentId: id,
            authToken,
            message,
            history,
            provider: llmSettings.provider,
            systemPrompt,
          }),
        });
        if (!bridgeResponse.ok) {
          const bodyText = await bridgeResponse.text();
          return c.json({
            error: "manual chat bridge failed",
            details: bodyText || `bridge returned HTTP ${bridgeResponse.status}`,
          }, 502);
        }
        return c.json(await bridgeResponse.json() as ManualChatBridgeResponse);
      } catch (error) {
        return c.json({
          error: "manual chat bridge unavailable",
          details: error instanceof Error ? error.message : String(error),
        }, 502);
      }
    }

    const reply = await callModelMessages(
      [
        { role: "system", content: systemPrompt },
        ...history.map((turn) => ({ role: turn.role, content: turn.content })),
        { role: "user", content: sandboxedMessage },
      ],
      {
        provider: llmSettings.provider,
        model: CHAT_MODEL,
        maxTokens: CHAT_MAX_TOKENS,
        temperature: 0.3,
        allowSubprocessProviders: false,
        allowLocalHttpProviders: false,
      },
    );

    return c.json({ reply });
  });

  // ── Ambient read-model routes (ADR 0029) ─────────────────────────────────────

  app.get("/api/runtime-map", async (c) => {
    const windowStr = c.req.query("windowMinutes");
    const windowMinutes = windowStr !== undefined ? parseInt(windowStr, 10) : undefined;
    const validWindow = windowMinutes !== undefined && !Number.isNaN(windowMinutes) && windowMinutes > 0
      ? windowMinutes : undefined;
    return c.json(await buildRuntimeMap(telemetryStore, storage, validWindow));
  });

  app.get("/api/services", async (c) => {
    const spans = await loadAmbientSpans(spanBuffer, telemetryStore, storage);
    return c.json(computeServices(spans, Date.now()));
  });

  app.get("/api/activity", async (c) => {
    const limitStr = c.req.query("limit");
    const rawLimit = limitStr !== undefined ? parseInt(limitStr, 10) : 20;
    const limit = Number.isNaN(rawLimit) ? 20 : Math.min(Math.max(rawLimit, 1), 100);
    const spans = await loadAmbientSpans(spanBuffer, telemetryStore, storage);
    return c.json(computeActivity(spans, limit));
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
      return c.json({ items: [] });
    }

    const limit = parseLimit(c.req.query("limit"), TELEMETRY_SPANS_DEFAULT_LIMIT);
    const cursor = c.req.query("cursor");
    const filter = {
      ...buildIncidentQueryFilter(telemetryScope),
      limit: boundedQueryLimit(cursor, limit, MAX_QUERY_SPANS),
      orderBy: "startTimeDesc" as const,
    };
    const spans = await telemetryStore.querySpans(filter);
    // Filter by spanMembership — only return incident-bound spans
    const membershipSet = new Set(spanMembership);
    const memberSpans = spans
      .filter((s) => membershipSet.has(spanMembershipKey(s.traceId, s.spanId)))
      .sort((a, b) =>
        b.startTimeMs - a.startTimeMs
        || b.durationMs - a.durationMs
        || a.serviceName.localeCompare(b.serviceName)
        || a.traceId.localeCompare(b.traceId)
        || a.spanId.localeCompare(b.spanId),
      );
    return c.json(paginateItems(memberSpans, limit, cursor));
  });

  app.get("/api/incidents/:id/telemetry/metrics", async (c) => {
    const id = c.req.param("id");
    const incident = await storage.getIncident(id);
    if (incident === null) {
      return c.json({ error: "not found" }, 404);
    }

    const { telemetryScope } = incident;
    if (telemetryScope.windowStartMs >= telemetryScope.windowEndMs) {
      return c.json({ items: [] });
    }

    const limit = parseLimit(c.req.query("limit"), TELEMETRY_METRICS_DEFAULT_LIMIT);
    const cursor = c.req.query("cursor");
    const filter = {
      ...buildIncidentQueryFilter(telemetryScope),
      limit: boundedQueryLimit(cursor, limit, MAX_QUERY_METRICS),
      orderBy: "startTimeDesc" as const,
    };
    const metrics = (await telemetryStore.queryMetrics(filter))
      .sort((a, b) =>
        b.startTimeMs - a.startTimeMs
        || a.service.localeCompare(b.service)
        || a.name.localeCompare(b.name),
      );
    return c.json(paginateItems(metrics, limit, cursor));
  });

  app.get("/api/incidents/:id/telemetry/logs", async (c) => {
    const id = c.req.param("id");
    const incident = await storage.getIncident(id);
    if (incident === null) {
      return c.json({ error: "not found" }, 404);
    }

    const { telemetryScope, spanMembership } = incident;
    if (telemetryScope.windowStartMs >= telemetryScope.windowEndMs) {
      return c.json({
        correlated: { items: [] },
        contextual: { items: [] },
      } satisfies TelemetryLogsPageResponse<unknown>);
    }

    const correlatedLimit = parseLimit(
      c.req.query("correlatedLimit"),
      TELEMETRY_LOGS_CORRELATED_DEFAULT_LIMIT,
    );
    const contextualLimit = parseLimit(
      c.req.query("contextualLimit"),
      TELEMETRY_LOGS_CONTEXTUAL_DEFAULT_LIMIT,
    );
    const correlatedCursor = c.req.query("correlatedCursor");
    const contextualCursor = c.req.query("contextualCursor");
    const logFetchLimit = boundedQueryLimit(
      undefined,
      parseCursor(correlatedCursor) + correlatedLimit + parseCursor(contextualCursor) + contextualLimit,
      MAX_QUERY_LOGS,
    );
    const filter = {
      ...buildIncidentQueryFilter(telemetryScope),
      limit: logFetchLimit,
      orderBy: "startTimeDesc" as const,
    };
    const logs = await telemetryStore.queryLogs(filter);

    // Build trace set from spanMembership for correlation
    const memberTraceIds = new Set(spanMembership.map(ref => ref.split(":")[0]));

    // Split logs into correlated (traceId matches spanMembership traces) and contextual
    const correlated = logs
      .filter((l) => l.traceId !== undefined && memberTraceIds.has(l.traceId))
      .sort((a, b) =>
        b.startTimeMs - a.startTimeMs
        || b.severityNumber - a.severityNumber
        || a.service.localeCompare(b.service)
        || a.bodyHash.localeCompare(b.bodyHash),
      );
    const contextual = logs
      .filter((l) => l.traceId === undefined || !memberTraceIds.has(l.traceId))
      .sort((a, b) =>
        b.startTimeMs - a.startTimeMs
        || b.severityNumber - a.severityNumber
        || a.service.localeCompare(b.service)
        || a.bodyHash.localeCompare(b.bodyHash),
      );

    return c.json({
      correlated: paginateItems(correlated, correlatedLimit, correlatedCursor),
      contextual: paginateItems(contextual, contextualLimit, contextualCursor),
    });
  });

  // ── Internal ops endpoint: regenerate stage 2 narrative ───────────────
  // CLI / ops script only. NOT UI-facing. Console UI must not call this.
  if (diagnosisRunner) {
    app.post("/api/incidents/:id/regenerate-narrative", async (c) => {
      const id = c.req.param("id");
      const success = await diagnosisRunner.rerunNarrative(id);
      if (success) {
        return c.json({ ok: true });
      }
      return c.json({ ok: false, error: "narrative regeneration failed" }, 500);
    });
  }

  return app;
}
