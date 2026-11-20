import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Builds .alex-build/render-worker.mjs (the email render worker) before the tests run.
    globalSetup: ["tests/global-setup.ts"],
    // Postgres-backed test files each drop and recreate the TEST_DATABASE_URL schema, so files run one at a time.
    fileParallelism: false,
  },
});
