import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { environment: "node", setupFiles: ["tests/setup-pg.ts"], testTimeout: 60_000, env: { PGLITE_DIR: "memory://" } },
});
