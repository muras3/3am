import { describe, it, expect, afterEach } from "vitest";
import { getRetentionHours, getRetentionCutoff, CLEANUP_INTERVAL_MS } from "../../retention/config.js";

describe("getRetentionHours", () => {
  const originalEnv = process.env["RETENTION_HOURS"];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["RETENTION_HOURS"];
    } else {
      process.env["RETENTION_HOURS"] = originalEnv;
    }
  });

  it("returns 1 when RETENTION_HOURS is unset", () => {
    delete process.env["RETENTION_HOURS"];
    expect(getRetentionHours()).toBe(1);
  });

  it("returns 1 when RETENTION_HOURS is empty string", () => {
    process.env["RETENTION_HOURS"] = "";
    expect(getRetentionHours()).toBe(1);
  });

  it("returns 1 for RETENTION_HOURS=1", () => {
    process.env["RETENTION_HOURS"] = "1";
    expect(getRetentionHours()).toBe(1);
  });

  it("returns 24 for RETENTION_HOURS=24", () => {
    process.env["RETENTION_HOURS"] = "24";
    expect(getRetentionHours()).toBe(24);
  });

  it("returns 72 for RETENTION_HOURS=72", () => {
    process.env["RETENTION_HOURS"] = "72";
    expect(getRetentionHours()).toBe(72);
  });

  it("returns 1 for invalid string RETENTION_HOURS=abc", () => {
    process.env["RETENTION_HOURS"] = "abc";
    expect(getRetentionHours()).toBe(1);
  });

  it("returns 1 for RETENTION_HOURS=0", () => {
    process.env["RETENTION_HOURS"] = "0";
    expect(getRetentionHours()).toBe(1);
  });

  it("returns 1 for RETENTION_HOURS=-1", () => {
    process.env["RETENTION_HOURS"] = "-1";
    expect(getRetentionHours()).toBe(1);
  });

  it("returns 1 for non-integer RETENTION_HOURS=1.5", () => {
    process.env["RETENTION_HOURS"] = "1.5";
    expect(getRetentionHours()).toBe(1);
  });
});

describe("getRetentionCutoff", () => {
  it("returns Date = now - retentionHours * 3600000", () => {
    delete process.env["RETENTION_HOURS"];
    const now = 1700000000000;
    const cutoff = getRetentionCutoff(now);
    expect(cutoff.getTime()).toBe(now - 1 * 60 * 60 * 1000);
  });

  it("respects RETENTION_HOURS=24", () => {
    process.env["RETENTION_HOURS"] = "24";
    const now = 1700000000000;
    const cutoff = getRetentionCutoff(now);
    expect(cutoff.getTime()).toBe(now - 24 * 60 * 60 * 1000);
    delete process.env["RETENTION_HOURS"];
  });
});

describe("CLEANUP_INTERVAL_MS", () => {
  it("is 5 minutes", () => {
    expect(CLEANUP_INTERVAL_MS).toBe(5 * 60 * 1000);
  });
});
