import { describe, it, expect, beforeEach, vi } from "vitest";
import { maybeCleanup, _resetCleanupTimerForTest } from "../../retention/lazy-cleanup.js";
import { CLEANUP_INTERVAL_MS } from "../../retention/config.js";
import type { StorageDriver } from "../../storage/interface.js";
import type { TelemetryStoreDriver } from "../../telemetry/interface.js";

function mockStorage(): StorageDriver {
  return {
    deleteExpiredIncidents: vi.fn().mockResolvedValue(undefined),
  } as unknown as StorageDriver;
}

function mockTelemetry(): TelemetryStoreDriver {
  return {
    deleteExpired: vi.fn().mockResolvedValue(undefined),
    deleteExpiredSnapshots: vi.fn().mockResolvedValue(undefined),
  } as unknown as TelemetryStoreDriver;
}

describe("maybeCleanup", () => {
  beforeEach(() => {
    _resetCleanupTimerForTest();
    delete process.env["RETENTION_HOURS"];
  });

  it("runs cleanup on first call (lastCleanupMs = 0)", async () => {
    const storage = mockStorage();
    const telemetry = mockTelemetry();
    const now = 1700000000000;

    await maybeCleanup(storage, telemetry, now);

    expect(storage.deleteExpiredIncidents).toHaveBeenCalledTimes(1);
    expect(telemetry.deleteExpired).toHaveBeenCalledTimes(1);
    expect(telemetry.deleteExpiredSnapshots).toHaveBeenCalledTimes(1);
  });

  it("skips cleanup within CLEANUP_INTERVAL_MS", async () => {
    const storage = mockStorage();
    const telemetry = mockTelemetry();
    const now = 1700000000000;

    await maybeCleanup(storage, telemetry, now);
    await maybeCleanup(storage, telemetry, now + CLEANUP_INTERVAL_MS - 1);

    expect(storage.deleteExpiredIncidents).toHaveBeenCalledTimes(1);
  });

  it("runs cleanup again after CLEANUP_INTERVAL_MS", async () => {
    const storage = mockStorage();
    const telemetry = mockTelemetry();
    const now = 1700000000000;

    await maybeCleanup(storage, telemetry, now);
    await maybeCleanup(storage, telemetry, now + CLEANUP_INTERVAL_MS);

    expect(storage.deleteExpiredIncidents).toHaveBeenCalledTimes(2);
    expect(telemetry.deleteExpired).toHaveBeenCalledTimes(2);
    expect(telemetry.deleteExpiredSnapshots).toHaveBeenCalledTimes(2);
  });

  it("does not throw on cleanup failure", async () => {
    const storage = mockStorage();
    (storage.deleteExpiredIncidents as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("DB error"),
    );
    const telemetry = mockTelemetry();

    // Should not throw
    await expect(maybeCleanup(storage, telemetry, 1700000000000)).resolves.toBeUndefined();
  });

  it("passes correct cutoff date based on RETENTION_HOURS", async () => {
    process.env["RETENTION_HOURS"] = "24";
    const storage = mockStorage();
    const telemetry = mockTelemetry();
    const now = 1700000000000;

    await maybeCleanup(storage, telemetry, now);

    const expectedCutoff = new Date(now - 24 * 60 * 60 * 1000);
    expect(storage.deleteExpiredIncidents).toHaveBeenCalledWith(expectedCutoff);
    expect(telemetry.deleteExpired).toHaveBeenCalledWith(expectedCutoff);
    expect(telemetry.deleteExpiredSnapshots).toHaveBeenCalledWith(expectedCutoff);
  });

  it("calls all three cleanup methods in parallel", async () => {
    const order: string[] = [];
    const storage = {
      deleteExpiredIncidents: vi.fn().mockImplementation(async () => {
        order.push("storage");
      }),
    } as unknown as StorageDriver;
    const telemetry = {
      deleteExpired: vi.fn().mockImplementation(async () => {
        order.push("telemetry");
      }),
      deleteExpiredSnapshots: vi.fn().mockImplementation(async () => {
        order.push("snapshots");
      }),
    } as unknown as TelemetryStoreDriver;

    await maybeCleanup(storage, telemetry, 1700000000000);

    expect(order).toHaveLength(3);
    expect(order).toContain("storage");
    expect(order).toContain("telemetry");
    expect(order).toContain("snapshots");
  });
});
