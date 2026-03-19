import { describe, it, expect } from "vitest";
import { updateEnvFile } from "../commands/init.js";

describe("updateEnvFile() — upgrade scenarios", () => {
  const localhostEnv = [
    "OTEL_SERVICE_NAME=my-app",
    "OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=development",
    "OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3333",
    "OTEL_EXPORTER_OTLP_HEADERS=",
    "",
  ].join("\n");

  it("replaces OTLP endpoint with production URL", () => {
    const result = updateEnvFile(localhostEnv, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://my-app.vercel.app",
    });
    expect(result).toContain("OTEL_EXPORTER_OTLP_ENDPOINT=https://my-app.vercel.app");
    expect(result).not.toContain("localhost:3333");
  });

  it("replaces OTLP headers with auth token", () => {
    const result = updateEnvFile(localhostEnv, {
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer abc-token-123",
    });
    expect(result).toContain("OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer abc-token-123");
  });

  it("applies both endpoint and headers in one call", () => {
    const result = updateEnvFile(localhostEnv, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://my-app.vercel.app",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer abc-token-123",
    });
    expect(result).toContain("OTEL_EXPORTER_OTLP_ENDPOINT=https://my-app.vercel.app");
    expect(result).toContain("OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer abc-token-123");
  });

  it("preserves OTEL_SERVICE_NAME and other keys when replacing endpoint", () => {
    const result = updateEnvFile(localhostEnv, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://my-app.vercel.app",
    });
    expect(result).toContain("OTEL_SERVICE_NAME=my-app");
  });

  it("environment name regex replaces development → production in OTEL_RESOURCE_ATTRIBUTES", () => {
    let env = updateEnvFile(localhostEnv, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://my-app.vercel.app",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer tok",
    });
    env = env.replace(
      /^(OTEL_RESOURCE_ATTRIBUTES=.*deployment\.environment\.name=)development(.*)$/m,
      "$1production$2",
    );
    expect(env).toContain("deployment.environment.name=production");
    expect(env).not.toContain("deployment.environment.name=development");
  });

  it("does not affect keys without deployment.environment.name when replacing", () => {
    const envWithExtras = localhostEnv + "OTHER_KEY=some-development-value\n";
    let result = updateEnvFile(envWithExtras, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://prod.example.com",
    });
    result = result.replace(
      /^(OTEL_RESOURCE_ATTRIBUTES=.*deployment\.environment\.name=)development(.*)$/m,
      "$1production$2",
    );
    expect(result).toContain("OTHER_KEY=some-development-value");
  });

  it("appends OTLP headers if not present in existing .env", () => {
    const envWithoutHeaders = "OTEL_SERVICE_NAME=my-app\nOTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3333\n";
    const result = updateEnvFile(envWithoutHeaders, {
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer tok",
    });
    expect(result).toContain("OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer tok");
  });
});
