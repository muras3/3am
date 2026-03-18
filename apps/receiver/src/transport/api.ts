import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { DiagnosisResultSchema, type DiagnosisResult } from "@3amoncall/core";
import { rateLimiter } from "../middleware/rate-limit.js";
import { SessionStore, sessionCookieSetter, sessionCookieValidator } from "../middleware/session-cookie.js";
import type { Incident, IncidentPage, StorageDriver } from "../storage/interface.js";
import { spanMembershipKey } from "../storage/interface.js";
import type { SpanBuffer } from "../ambient/span-buffer.js";
import type { TelemetryStoreDriver } from "../telemetry/interface.js";
import { buildIncidentQueryFilter } from "../telemetry/interface.js";
import { computeServices, computeActivity } from "../ambient/service-aggregator.js";

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

  // Session cookie + rate limit for chat endpoint (B-11)
  // Cookie is set on all /api/* responses; validated only on /api/chat/*.
  // Active only when RECEIVER_AUTH_TOKEN is set (production). In dev mode, rate limit only.
  const authToken = process.env["RECEIVER_AUTH_TOKEN"];
  const allowInsecure = process.env["ALLOW_INSECURE_DEV_MODE"] === "true";
  if (authToken) {
    const sessionStore = new SessionStore();
    app.use("/api/*", sessionCookieSetter(sessionStore, { secure: !allowInsecure }));
    app.use("/api/chat/*", sessionCookieValidator(sessionStore));
  }
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
    return c.json(toIncidentResponse(incident));
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
