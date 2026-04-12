import { defineConfig, devices } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path exported so global-setup.ts can write to the same location.
// The file is written by globalSetup before any test runs, so it always exists
// when Playwright loads storageState for each test context.
export const E2E_STORAGE_STATE = path.resolve(__dirname, "e2e/.auth/storage.json");

export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["**/screenshots.spec.ts", "**/*.receiver-served.spec.ts"],
  timeout: 30_000,
  retries: process.env["CI"] ? 2 : 0,
  reporter: process.env["CI"] ? "github" : "list",

  globalSetup: path.resolve(__dirname, "./e2e/global-setup.ts"),
  globalTeardown: path.resolve(__dirname, "./e2e/global-teardown.ts"),

  use: {
    baseURL: `http://localhost:${process.env["E2E_VITE_PORT"] ?? "5174"}`,
    trace: "on-first-retry",
    storageState: E2E_STORAGE_STATE,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command:
      `VITE_RECEIVER_BASE_URL=http://localhost:4319 pnpm dev --port ${process.env["E2E_VITE_PORT"] ?? "5174"}`,
    url: `http://localhost:${process.env["E2E_VITE_PORT"] ?? "5174"}`,
    reuseExistingServer: !process.env["CI"],
    timeout: 30_000,
  },
});
