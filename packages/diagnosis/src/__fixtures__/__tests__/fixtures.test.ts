import { describe, expect, it } from "vitest";
import { ReasoningStructureSchema, DiagnosisResultSchema } from "@3am/core";
import { allFixtures as rsFixtures } from "../reasoning-structures.js";
import { allFixtures as drFixtures } from "../diagnosis-results.js";

describe("ReasoningStructure fixtures", () => {
  for (const [name, fixture] of Object.entries(rsFixtures)) {
    it(`${name}: passes schema validation`, () => {
      expect(() => ReasoningStructureSchema.parse(fixture)).not.toThrow();
    });
  }
});

describe("DiagnosisResult fixtures", () => {
  for (const [name, fixture] of Object.entries(drFixtures)) {
    it(`${name}: passes schema validation`, () => {
      expect(() => DiagnosisResultSchema.parse(fixture)).not.toThrow();
    });
  }
});
