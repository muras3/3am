import type { Framework } from "./detect-framework.js";

export function nextjsVercelTemplate(): string {
  return `import { registerOTel } from "@vercel/otel";
import type { Configuration } from "@vercel/otel";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BunyanInstrumentation } from "@opentelemetry/instrumentation-bunyan";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { WinstonInstrumentation } from "@opentelemetry/instrumentation-winston";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

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

function createSignalPipeline(
  baseUrl: string
): Pick<Configuration, "traceExporter" | "metricReaders" | "logRecordProcessors"> {
  const headers = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);

  const traceConfig = { url: buildOtlpUrl(baseUrl, "traces"), headers };
  const metricConfig = { url: buildOtlpUrl(baseUrl, "metrics"), headers };
  const logConfig = { url: buildOtlpUrl(baseUrl, "logs"), headers };

  return {
    traceExporter: new OTLPTraceExporter(traceConfig),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(metricConfig),
        exportIntervalMillis: 5000,
        exportTimeoutMillis: 3000,
      }),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter(logConfig),
        { scheduledDelayMillis: 1000, exportTimeoutMillis: 3000 }
      ),
    ],
  };
}

function createInstrumentations(): NonNullable<Configuration["instrumentations"]> {
  return [
    ...getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-pino": { enabled: false },
      "@opentelemetry/instrumentation-winston": { enabled: false },
      "@opentelemetry/instrumentation-bunyan": { enabled: false },
    }),
    new PinoInstrumentation(),
    new WinstonInstrumentation({ logSeverity: SeverityNumber.WARN }),
    new BunyanInstrumentation({ logSeverity: SeverityNumber.WARN }),
  ];
}

export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (globalThis.__otelAllSignalsRegistered) return;

  const otlpBaseUrl = getOtlpBaseUrl();
  if (!otlpBaseUrl) {
    console.warn("OTel not configured: OTEL_EXPORTER_OTLP_ENDPOINT is missing.");
    return;
  }

  globalThis.__otelAllSignalsRegistered = true;

  try {
    const pipeline = createSignalPipeline(otlpBaseUrl);
    registerOTel({
      serviceName: process.env.OTEL_SERVICE_NAME || "my-app",
      attributes: {
        "deployment.environment.name":
          process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
      },
      instrumentations: createInstrumentations(),
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
