import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/__tests__/workers/fixtures/receiver-worker.ts",
      wrangler: {
        configPath: "./wrangler.toml",
      },
      miniflare: {
        compatibilityDate: "2025-03-01",
        compatibilityFlags: ["nodejs_compat_v2"],
        RECEIVER_AUTH_TOKEN: "workers-test-token",
        ALLOW_INSECURE_DEV_MODE: "true",
      },
    }),
  ],
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
    include: ["src/__tests__/workers/**/*.test.ts"],
  },
});
