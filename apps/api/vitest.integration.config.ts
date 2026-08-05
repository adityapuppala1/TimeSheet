import { defineConfig } from "vitest/config";
import { deriveTestDbUrls } from "./tests/setup/derive-test-db-urls.js";

const { tenantUrl, controlUrl } = deriveTestDbUrls();

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    globals: false,
    restoreMocks: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Both integration test files share ONE pair of throwaway databases (created once in
    // globalSetup) — running them concurrently would race on the same rows.
    fileParallelism: false,
    globalSetup: ["./tests/setup/global-setup.integration.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL: tenantUrl,
      CONTROL_DATABASE_URL: controlUrl
      // JWT_*_SECRET / ENCRYPTION_KEY / ANTHROPIC_API_KEY are deliberately NOT overridden here —
      // they fall through from the developer's real apps/api/.env (dotenv.config() in env.ts
      // never clobbers an already-set process.env var), so encryptSecret/decryptSecret used by
      // global-setup's seeding and by the app code under test agree on the same key.
    }
  }
});
