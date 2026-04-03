import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      {
        find: /^@3am\/core$/,
        replacement: path.resolve(__dirname, "../../packages/core/src/index.ts"),
      },
      {
        find: /^@3am\/core\/(.+)$/,
        replacement: path.resolve(__dirname, "../../packages/core/src/$1.ts"),
      },
    ],
  },
  server: {
    proxy: {
      "/api": {
        target: process.env["VITE_RECEIVER_BASE_URL"] ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    globals: true,
    exclude: ["**/node_modules/**", "**/e2e/**"],
  },
});
