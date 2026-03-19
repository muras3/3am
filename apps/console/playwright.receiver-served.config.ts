import { defineConfig, devices } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path exported so global-setup.receiver-served.ts can write to the same location.
export const E2E_RECEIVER_SERVED_STORAGE_STATE = path.resolve(
  __dirname,
  "e2e/.auth/storage-receiver-served.json",
);

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["specs/**/*.spec.ts"],
  timeout: 30_000,
  retries: process.env["CI"] ? 2 : 0,
  reporter: process.env["CI"] ? "github" : "list",

  globalSetup: path.resolve(__dirname, "./e2e/global-setup.receiver-served.ts"),
  globalTeardown: path.resolve(__dirname, "./e2e/global-teardown.ts"),

  use: {
    baseURL: "http://localhost:4321",
    trace: "on-first-retry",
    storageState: E2E_RECEIVER_SERVED_STORAGE_STATE,
  },

  // Platform-agnostic snapshot path: same baseline works on macOS + Linux CI.
  // Omitting {platform} avoids "missing snapshot" failures when baselines are
  // committed from macOS and compared on Ubuntu in CI.
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}",

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
