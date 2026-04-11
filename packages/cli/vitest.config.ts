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
      {
        find: /^@3am\/diagnosis\/(.+)$/,
        replacement: path.resolve(__dirname, "../../packages/diagnosis/src/$1.ts"),
      },
    ],
  },
  test: {
    exclude: ["dist/**", "node_modules/**"],
  },
});
