import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadCredentials } from "./init/credentials.js";
import { runManualChat, runManualDiagnosis, runManualEvidenceQuery } from "./manual-execution.js";
import { resolveProviderModel } from "./provider-model.js";

export interface BridgeOptions {
  port?: number;
}

function sendJson(res: ServerResponse<IncomingMessage>, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.end(JSON.stringify(body));
}

async function readBody(req: AsyncIterable<Buffer | string>): Promise<unknown> {
  const chunks: string[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
  }
  return chunks.length > 0 ? JSON.parse(chunks.join("")) : {};
}

export function runBridge(options: BridgeOptions = {}): void {
  const port = options.port ?? 4269;
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (!req.url) {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    try {
      if (req.method === "GET" && req.url === "/healthz") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      if (req.method === "POST" && req.url === "/api/manual/diagnose") {
        const body = await readBody(req);
        const payload = body as {
          receiverUrl: string;
          incidentId: string;
          authToken?: string;
          provider?: ReturnType<typeof loadCredentials>["llmProvider"];
          model?: string;
        };
        const creds = loadCredentials();
        const provider = payload.provider ?? creds.llmProvider;
        const result = await runManualDiagnosis({
          receiverUrl: payload.receiverUrl,
          incidentId: payload.incidentId,
          authToken: payload.authToken,
          provider,
          model: resolveProviderModel(provider, payload.model, creds.llmModel),
          locale: creds.locale === "ja" ? "ja" : "en",
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && req.url === "/api/manual/chat") {
        const body = await readBody(req);
        const payload = body as {
          receiverUrl: string;
          incidentId: string;
          authToken?: string;
          message: string;
          history?: Array<{ role: "user" | "assistant"; content: string }>;
          provider?: ReturnType<typeof loadCredentials>["llmProvider"];
          model?: string;
          systemPrompt?: string;
        };
        const creds = loadCredentials();
        const provider = payload.provider ?? creds.llmProvider;
        const result = await runManualChat({
          receiverUrl: payload.receiverUrl,
          incidentId: payload.incidentId,
          authToken: payload.authToken,
          message: payload.message,
          history: payload.history ?? [],
          provider,
          model: resolveProviderModel(provider, payload.model, creds.llmModel),
          locale: creds.locale === "ja" ? "ja" : "en",
          systemPrompt: payload.systemPrompt,
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && req.url === "/api/manual/evidence-query") {
        const body = await readBody(req);
        const payload = body as {
          receiverUrl: string;
          incidentId: string;
          authToken?: string;
          question: string;
          history?: Array<{ role: "user" | "assistant"; content: string }>;
          provider?: ReturnType<typeof loadCredentials>["llmProvider"];
          model?: string;
        };
        const creds = loadCredentials();
        const provider = payload.provider ?? creds.llmProvider;
        const result = await runManualEvidenceQuery({
          receiverUrl: payload.receiverUrl,
          incidentId: payload.incidentId,
          authToken: payload.authToken,
          question: payload.question,
          history: payload.history ?? [],
          provider,
          model: resolveProviderModel(provider, payload.model, creds.llmModel),
          locale: creds.locale === "ja" ? "ja" : "en",
        });
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`3am bridge listening on http://127.0.0.1:${port}\n`);
  });
}
