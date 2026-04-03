import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@3am\/core$/,
        replacement: path.resolve(__dirname, "../../packages/core/src/index.ts"),
      },
      {
        find: /^@3am\/core\/(.+)$/,
        replacement: path.resolve(__dirname, "../../packages/core/src/$1.ts"),
      },
      {
        find: /^@3am\/diagnosis$/,
        replacement: path.resolve(__dirname, "../../packages/diagnosis/src/index.ts"),
      },
    ],
  },
  test: {
    include: [
      "src/__tests__/**/*.test.ts",
      "src/runtime/__tests__/**/*.test.ts",
      "src/notification/__tests__/**/*.test.ts",
    ],
    exclude: ["src/__tests__/workers/**/*.test.ts"],
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
