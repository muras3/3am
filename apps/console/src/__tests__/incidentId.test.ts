import { describe, expect, it } from "vitest";
import {
  encodeIncidentId,
  formatShortIncidentId,
  parseIncidentId,
} from "../lib/incidentId.js";

describe("incidentId helpers", () => {
  it("accepts expected incident ids", () => {
    expect(parseIncidentId("inc_test_001")).toBe("inc_test_001");
    expect(parseIncidentId("inc_833133a8-5e8c-49c7-8177-2dc7cd900cf9")).toBe(
      "inc_833133a8-5e8c-49c7-8177-2dc7cd900cf9",
    );
  });

  it("rejects invalid or traversal-like incident ids", () => {
    expect(parseIncidentId(undefined)).toBeUndefined();
    expect(parseIncidentId("")).toBeUndefined();
    expect(parseIncidentId("../services")).toBeUndefined();
    expect(parseIncidentId("inc_../services")).toBeUndefined();
    expect(parseIncidentId("incident-123")).toBeUndefined();
  });

  it("encodes path-sensitive characters before building API URLs", () => {
    expect(encodeIncidentId("inc_test_001")).toBe("inc_test_001");
    expect(encodeIncidentId("inc_../services")).toBe("inc_..%2Fservices");
  });

  it("formats short incident ids for console display", () => {
    expect(formatShortIncidentId("inc_0892")).toBe("INC-0892");
    expect(formatShortIncidentId("inc_000001")).toBe("INC-000001");
    expect(formatShortIncidentId("INC-000042")).toBe(
      "INC-000042",
    );
  });
});
