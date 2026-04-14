/**
 * Tests for resolveDevStorage — verifies storage selection logic in dev mode.
 *
 * Uses a real temp directory so we exercise mkdirSync + SQLiteAdapter
 * without network or port binding.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveDevStorage } from "../storage/dev-storage.js";
import { SQLiteAdapter } from "../storage/drizzle/sqlite.js";

/** Create an isolated temp dir for each test scenario. */
function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "3am-dev-storage-test-"));
}

describe("resolveDevStorage", () => {
  const dirsToClean: string[] = [];

  afterEach(() => {
    for (const dir of dirsToClean) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirsToClean.length = 0;
  });

  it("returns SQLiteAdapter when ALLOW_INSECURE_DEV_MODE=true and no DATABASE_URL", () => {
    const cwd = makeTmpDir();
    dirsToClean.push(cwd);

    const result = resolveDevStorage(
      { ALLOW_INSECURE_DEV_MODE: "true" },
      cwd,
    );

    expect(result).toBeInstanceOf(SQLiteAdapter);
  });

  it("creates .3am/dev.db on disk", () => {
    const cwd = makeTmpDir();
    dirsToClean.push(cwd);

    resolveDevStorage({ ALLOW_INSECURE_DEV_MODE: "true" }, cwd);

    expect(existsSync(join(cwd, ".3am", "dev.db"))).toBe(true);
  });

  it("returns null when DATABASE_URL is set (production mode — caller handles Postgres)", () => {
    const cwd = makeTmpDir();
    dirsToClean.push(cwd);

    const result = resolveDevStorage(
      { DATABASE_URL: "postgres://localhost/prod", ALLOW_INSECURE_DEV_MODE: "true" },
      cwd,
    );

    expect(result).toBeNull();
  });

  it("returns null when ALLOW_INSECURE_DEV_MODE is not set", () => {
    const cwd = makeTmpDir();
    dirsToClean.push(cwd);

    const result = resolveDevStorage({}, cwd);

    expect(result).toBeNull();
  });

  it("returns null when ALLOW_INSECURE_DEV_MODE=false", () => {
    const cwd = makeTmpDir();
    dirsToClean.push(cwd);

    const result = resolveDevStorage({ ALLOW_INSECURE_DEV_MODE: "false" }, cwd);

    expect(result).toBeNull();
  });

  it("returns null and logs warning when SQLite cannot be created (unwritable path)", () => {
    // Pass a path that cannot be written to — use a file as a directory to force failure.
    // We rely on the try/catch in resolveDevStorage returning null gracefully.
    const cwd = "/dev/null/not-a-dir"; // guaranteed not writable

    const result = resolveDevStorage({ ALLOW_INSECURE_DEV_MODE: "true" }, cwd);

    expect(result).toBeNull();
  });

  it("is idempotent — calling twice with same path succeeds (SQLiteAdapter migrates with IF NOT EXISTS)", () => {
    const cwd = makeTmpDir();
    dirsToClean.push(cwd);

    const env = { ALLOW_INSECURE_DEV_MODE: "true" };
    const first = resolveDevStorage(env, cwd);
    const second = resolveDevStorage(env, cwd);

    expect(first).toBeInstanceOf(SQLiteAdapter);
    expect(second).toBeInstanceOf(SQLiteAdapter);
  });
});
