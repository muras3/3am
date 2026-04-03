import { logs } from "@opentelemetry/api-logs";
import { resolveSelfTelemetryConfig, type SelfTelemetryRuntime } from "./config.js";

type LogSeverity = "DEBUG" | "INFO" | "WARN" | "ERROR";

const severityNumbers: Record<LogSeverity, number> = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
};

function resolveRuntime(): SelfTelemetryRuntime {
  return (
    (process.env["THREEAM_RUNTIME"] as SelfTelemetryRuntime | undefined) ?? "node"
  );
}

function shouldWriteConsole(runtime: SelfTelemetryRuntime): boolean {
  return runtime === "cloudflare-workers" || process.env["SELF_OTEL_CONSOLE_LOGS"] === "true";
}

export function isSelfTelemetryActive(runtime = resolveRuntime()): boolean {
  return resolveSelfTelemetryConfig(runtime).enabled;
}

export function emitSelfTelemetryLog(input: {
  severity: LogSeverity;
  body: string;
  attributes?: Record<string, string | number | boolean | undefined>;
}): void {
  const runtime = resolveRuntime();
  const config = resolveSelfTelemetryConfig(runtime);

  if (!config.enabled && !shouldWriteConsole(runtime)) {
    return;
  }

  const attributes = {
    "service.name": config.serviceName,
    "service.namespace": config.serviceNamespace,
    "deployment.environment.name": config.deploymentEnvironment,
    "3am.telemetry.stream": "self",
    "3am.runtime": runtime,
    ...input.attributes,
  };

  try {
    logs.getLogger("3am.receiver.self").emit({
      severityNumber: severityNumbers[input.severity],
      severityText: input.severity,
      body: input.body,
      attributes,
    });
  } catch {
    // Logging must not break request handling.
  }

  if (shouldWriteConsole(runtime)) {
    const payload = {
      ts: new Date().toISOString(),
      level: input.severity.toLowerCase(),
      message: input.body,
      ...attributes,
    };
    const method =
      input.severity === "ERROR"
        ? console.error
        : input.severity === "WARN"
          ? console.warn
          : console.log;
    method(JSON.stringify(payload));
  }
}
