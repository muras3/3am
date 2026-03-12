import { describe, expect, it } from "vitest";
import { encodeIncidentId, parseIncidentId } from "../lib/incidentId.js";

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
});
