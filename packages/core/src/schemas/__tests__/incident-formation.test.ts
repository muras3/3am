import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  IncidentFormationKeySchema,
  IncidentStatusSchema,
  IncidentFormationContextSchema,
} from "../incident-formation.js";

describe("IncidentFormationKeySchema", () => {
  it("accepts a valid formation key with all required fields", () => {
    const result = IncidentFormationKeySchema.parse({
      environment: "production",
      timeWindow: { start: "2026-03-08T00:00:00Z", end: "2026-03-08T00:08:00Z" },
      primaryService: "web",
      dependency: "stripe",
    });
    expect(result.environment).toBe("production");
    expect(result.primaryService).toBe("web");
  });

  it("allows dependency to be optional", () => {
    const result = IncidentFormationKeySchema.parse({
      environment: "production",
      timeWindow: { start: "2026-03-08T00:00:00Z", end: "2026-03-08T00:08:00Z" },
      primaryService: "web",
    });
    expect(result.dependency).toBeUndefined();
  });

  it("requires environment, timeWindow, primaryService", () => {
    expect(() =>
      IncidentFormationKeySchema.parse({ primaryService: "web" })
    ).toThrow(ZodError);
  });
});

describe("IncidentFormationContextSchema", () => {
  it("accepts an empty supplemental context (all optional)", () => {
    const result = IncidentFormationContextSchema.parse({});
    expect(result).toBeDefined();
  });

  it("accepts supplemental context fields when provided", () => {
    const result = IncidentFormationContextSchema.parse({
      deploymentId: "deploy_abc",
      configChange: "feature-flag-x enabled",
      route: "/checkout",
      platformEvent: "scale-up",
    });
    expect(result.deploymentId).toBe("deploy_abc");
    expect(result.route).toBe("/checkout");
  });
});

describe("IncidentStatusSchema", () => {
  it("accepts 'open'", () => {
    expect(IncidentStatusSchema.parse("open")).toBe("open");
  });

  it("accepts 'closed'", () => {
    expect(IncidentStatusSchema.parse("closed")).toBe("closed");
  });

  it("rejects unknown status values", () => {
    expect(() => IncidentStatusSchema.parse("unknown")).toThrow(ZodError);
  });
});
