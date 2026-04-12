import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, type LogRecordExporter } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { resolveSelfTelemetryConfig, type SelfTelemetryRuntime } from "./config.js";

let sdkPromise: Promise<NodeSDK | null> | null = null;

function appendPath(endpoint: string, suffix: "/v1/traces" | "/v1/logs" | "/v1/metrics"): string {
  return `${endpoint.replace(/\/$/, "")}${suffix}`;
}

export async function initializeNodeSelfTelemetry(
  runtime: Exclude<SelfTelemetryRuntime, "cloudflare-workers">,
): Promise<NodeSDK | null> {
  process.env["THREEAM_RUNTIME"] = runtime;

  if (sdkPromise) {
    return sdkPromise;
  }

  const config = resolveSelfTelemetryConfig(runtime);
  if (!config.enabled || !config.exporterEndpoint) {
    sdkPromise = Promise.resolve(null);
    return sdkPromise;
  }

  if (process.env["SELF_OTEL_DEBUG"] === "true") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  sdkPromise = (async () => {
    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: config.serviceName,
        [ATTR_SERVICE_NAMESPACE]: config.serviceNamespace,
        [ATTR_SERVICE_VERSION]: config.serviceVersion,
        "deployment.environment.name": config.deploymentEnvironment,
        "3am.telemetry.stream": "self",
        "3am.runtime": runtime,
      }),
      traceExporter: new OTLPTraceExporter({
        url: appendPath(config.exporterEndpoint!, "/v1/traces"),
        headers: config.exporterHeaders,
      }),
      logRecordProcessors: [
        new BatchLogRecordProcessor(
          new OTLPLogExporter({
            url: appendPath(config.exporterEndpoint!, "/v1/logs"),
            headers: config.exporterHeaders,
          }) as unknown as LogRecordExporter,
          { scheduledDelayMillis: 200 },
        ),
      ],
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: appendPath(config.exporterEndpoint!, "/v1/metrics"),
          headers: config.exporterHeaders,
        }) as unknown as PushMetricExporter,
        exportIntervalMillis: 5000,
        exportTimeoutMillis: 2000,
      }),
      instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()],
    });

    sdk.start();
    return sdk;
  })();

  return sdkPromise;
}

export async function flushNodeSelfTelemetry(): Promise<void> {
  await Promise.resolve();
}

export async function shutdownNodeSelfTelemetry(): Promise<void> {
  const sdk = await sdkPromise;
  sdkPromise = null;
  await sdk?.shutdown();
}
