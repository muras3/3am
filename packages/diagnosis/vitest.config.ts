import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@3amoncall\/core$/,
        replacement: path.resolve(__dirname, "../core/src/index.ts"),
      },
      {
        find: /^@3amoncall\/core\/(.+)$/,
        replacement: path.resolve(__dirname, "../core/src/$1.ts"),
      },
    ],
  },
});
