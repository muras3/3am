export type SelfTelemetryRuntime = "node" | "vercel" | "cloudflare-workers";

export interface SelfTelemetryConfig {
  enabled: boolean;
  exporterEndpoint: string | null;
  exporterHeaders: Record<string, string>;
  serviceName: string;
  serviceNamespace: string;
  serviceVersion: string;
  deploymentEnvironment: string;
  runtime: SelfTelemetryRuntime;
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .reduce<Record<string, string>>((headers, entry) => {
      const index = entry.indexOf("=");
      if (index === -1) return headers;

      const key = entry.slice(0, index).trim();
      const value = entry.slice(index + 1).trim();
      if (key.length > 0 && value.length > 0) {
        headers[key] = value;
      }
      return headers;
    }, {});
}

function resolveDeploymentEnvironment(runtime: SelfTelemetryRuntime): string {
  if (process.env["SELF_OTEL_DEPLOYMENT_ENVIRONMENT"]) {
    return process.env["SELF_OTEL_DEPLOYMENT_ENVIRONMENT"]!;
  }
  if (runtime === "vercel") {
    return process.env["VERCEL_ENV"] ?? process.env["NODE_ENV"] ?? "production";
  }
  if (runtime === "cloudflare-workers") {
    return process.env["CF_ENV"] ?? "production";
  }
  return process.env["NODE_ENV"] ?? "development";
}

export function resolveSelfTelemetryConfig(
  runtime: SelfTelemetryRuntime,
): SelfTelemetryConfig {
  const exporterEndpoint = process.env["SELF_OTEL_EXPORTER_OTLP_ENDPOINT"] ?? null;
  const enabled =
    process.env["SELF_OTEL_ENABLED"] === "true" ||
    (runtime !== "cloudflare-workers" && exporterEndpoint !== null);

  return {
    enabled,
    exporterEndpoint,
    exporterHeaders: parseHeaders(process.env["SELF_OTEL_EXPORTER_OTLP_HEADERS"]),
    serviceName: process.env["SELF_OTEL_SERVICE_NAME"] ?? "3amoncall-receiver",
    serviceNamespace: process.env["SELF_OTEL_SERVICE_NAMESPACE"] ?? "3amoncall",
    serviceVersion: process.env["npm_package_version"] ?? "0.1.0",
    deploymentEnvironment: resolveDeploymentEnvironment(runtime),
    runtime,
  };
}
