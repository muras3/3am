import type { Framework } from "./detect-framework.js";

export function nextjsVercelTemplate(): string {
  return `import { registerOTel } from "@vercel/otel";
import type { Configuration } from "@vercel/otel";

declare global {
  var __otelAllSignalsRegistered: boolean | undefined;
}

function getOtlpBaseUrl(): string | undefined {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return endpoint ? endpoint.replace(/\\/+$/, "") : undefined;
}

function buildOtlpUrl(baseUrl: string, signal: "traces" | "metrics" | "logs") {
  return \`\${baseUrl}/v1/\${signal}\`;
}

function parseOtlpHeaders(raw: string | undefined) {
  if (!raw?.trim()) return undefined;
  const headers: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (key) headers[key] = val;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

async function createSignalPipeline(
  baseUrl: string
): Promise<
  Pick<Configuration, "traceExporter" | "metricReaders" | "logRecordProcessors">
> {
  const headers = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);

  const [traceExp, metricExp, logExp, sdkMetrics, sdkLogs] = await Promise.all([
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
    import("@opentelemetry/exporter-logs-otlp-http"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/sdk-logs"),
  ]);

  const traceConfig = { url: buildOtlpUrl(baseUrl, "traces"), headers };
  const metricConfig = { url: buildOtlpUrl(baseUrl, "metrics"), headers };
  const logConfig = { url: buildOtlpUrl(baseUrl, "logs"), headers };

  return {
    traceExporter: new traceExp.OTLPTraceExporter(traceConfig),
    metricReaders: [
      new sdkMetrics.PeriodicExportingMetricReader({
        exporter: new metricExp.OTLPMetricExporter(metricConfig),
        exportIntervalMillis: 5000,
        exportTimeoutMillis: 3000,
      }),
    ],
    logRecordProcessors: [
      new sdkLogs.BatchLogRecordProcessor(
        new logExp.OTLPLogExporter(logConfig),
        { scheduledDelayMillis: 1000, exportTimeoutMillis: 3000 }
      ),
    ],
  } as Pick<
    Configuration,
    "traceExporter" | "metricReaders" | "logRecordProcessors"
  >;
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (globalThis.__otelAllSignalsRegistered) return;

  const otlpBaseUrl = getOtlpBaseUrl();
  if (!otlpBaseUrl) {
    console.warn("OTel not configured: OTEL_EXPORTER_OTLP_ENDPOINT is missing.");
    return;
  }

  globalThis.__otelAllSignalsRegistered = true;

  try {
    const [pipeline, { getNodeAutoInstrumentations }] = await Promise.all([
      createSignalPipeline(otlpBaseUrl),
      import("@opentelemetry/auto-instrumentations-node"),
    ]);
    registerOTel({
      serviceName: process.env.OTEL_SERVICE_NAME || "my-app",
      attributes: {
        "deployment.environment.name":
          process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
      },
      instrumentations: [getNodeAutoInstrumentations()],
      ...pipeline,
    });
  } catch (error) {
    globalThis.__otelAllSignalsRegistered = false;
    throw error;
  }
}
`;
}

export function getInstrumentationTemplate(framework: Framework): string {
  if (framework === "nextjs") {
    return `import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
  }),
  logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter()),
  instrumentations: [getNodeAutoInstrumentations()],
});

export function register() {
  sdk.start();
}
`;
  }

  return `import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
  }),
  logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter()),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
`;
}
