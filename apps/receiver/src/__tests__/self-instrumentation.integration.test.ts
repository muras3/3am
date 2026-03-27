import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "../index.js";
import {
  initializeNodeSelfTelemetry,
  shutdownNodeSelfTelemetry,
} from "../self-telemetry/node.js";
import { errorSpanPayload } from "./fixtures/integration-helpers.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve listening port");
  }
  return address.port;
}

describe("self-instrumentation integration", () => {
  let otlpServer: Server;
  let receiverServer: ReturnType<typeof serve>;
  const traceBodies: unknown[] = [];
  const logBodies: unknown[] = [];

  beforeEach(async () => {
    process.env["ALLOW_INSECURE_DEV_MODE"] = "true";
    process.env["SELF_OTEL_ENABLED"] = "true";
    process.env["SELF_OTEL_CONSOLE_LOGS"] = "false";

    otlpServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (req.url === "/v1/traces") {
        traceBodies.push(body);
      } else if (req.url === "/v1/logs") {
        logBodies.push(body);
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });

    const otlpPort = await listen(otlpServer);
    process.env["SELF_OTEL_EXPORTER_OTLP_ENDPOINT"] = `http://127.0.0.1:${otlpPort}`;
    await initializeNodeSelfTelemetry("node");

    const app = createApp(undefined, { resolvedAuthToken: null });
    receiverServer = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const server = serve(
        { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
        () => resolve(server),
      );
    });
  });

  afterEach(async () => {
    await shutdownNodeSelfTelemetry();
    await new Promise<void>((resolve, reject) => {
      receiverServer.close((error?: Error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      otlpServer.close((error) => (error ? reject(error) : resolve()));
    });

    traceBodies.length = 0;
    logBodies.length = 0;
    delete process.env["ALLOW_INSECURE_DEV_MODE"];
    delete process.env["SELF_OTEL_CONSOLE_LOGS"];
    delete process.env["SELF_OTEL_ENABLED"];
    delete process.env["SELF_OTEL_EXPORTER_OTLP_ENDPOINT"];
  });

  it("emits real OTLP traces and logs for receiver HTTP traffic", async () => {
    const address = receiverServer.address();
    if (!address || typeof address === "string") {
      throw new Error("receiver did not expose a TCP address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const healthRes = await fetch(`${baseUrl}/healthz`);
    expect(healthRes.status).toBe(200);

    const tracesRes = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(errorSpanPayload),
    });
    expect(tracesRes.status).toBe(200);

    const incidentsRes = await fetch(`${baseUrl}/api/incidents`);
    expect(incidentsRes.status).toBe(200);

    const missingRes = await fetch(`${baseUrl}/api/incidents/missing`);
    expect(missingRes.status).toBe(404);

    await wait(500);
    await shutdownNodeSelfTelemetry();

    const serviceNames = traceBodies
      .flatMap((body) => (body as { resourceSpans?: Array<{ resource?: { attributes?: Array<{ key?: string; value?: { stringValue?: string } }> } }> }).resourceSpans ?? [])
      .flatMap((resourceSpan) => resourceSpan.resource?.attributes ?? [])
      .filter((attribute) => attribute.key === "service.name")
      .map((attribute) => attribute.value?.stringValue);
    expect(serviceNames).toContain("3amoncall-receiver");

    const requestSpans = traceBodies
      .flatMap((body) => (body as { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<{ attributes?: Array<{ key?: string; value?: { stringValue?: string } }> }> }> }> }).resourceSpans ?? [])
      .flatMap((resourceSpan) => resourceSpan.scopeSpans ?? [])
      .flatMap((scopeSpan) => scopeSpan.spans ?? [])
      .filter((span) =>
        (span.attributes ?? []).some(
          (attribute) =>
            attribute.key === "url.path" &&
            ["/healthz", "/v1/traces", "/api/incidents", "/api/incidents/missing"].includes(
              attribute.value?.stringValue ?? "",
            ),
        ),
      );
    expect(requestSpans.length).toBeGreaterThanOrEqual(4);

    const requestLogs = logBodies
      .flatMap((body) => (body as { resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: Array<{ body?: { stringValue?: string }; attributes?: Array<{ key?: string; value?: { stringValue?: string; intValue?: number } }> }> }> }> }).resourceLogs ?? [])
      .flatMap((resourceLog) => resourceLog.scopeLogs ?? [])
      .flatMap((scopeLog) => scopeLog.logRecords ?? [])
      .filter((record) => record.body?.stringValue === "receiver.request");

    expect(requestLogs.length).toBeGreaterThanOrEqual(4);
    expect(
      requestLogs.some((record) =>
        (record.attributes ?? []).some(
          (attribute) =>
            attribute.key === "http.response.status_code" &&
            attribute.value?.intValue === 404,
        ),
      ),
    ).toBe(true);
  });
});
