import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Postgres test files share a single database and use TRUNCATE for isolation.
    // File-level parallelism causes cross-file TRUNCATE races (one file wipes
    // another file's data). Disabling parallelism is safe — the suite is ~2s.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/**/*.test.ts", "src/scripts/**"],
      reporter: ["text", "text-summary"],
      // Thresholds are informational — CI will report but not fail on coverage
    },
  },
});
