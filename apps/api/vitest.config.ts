import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    globals: false,
    restoreMocks: true,
    testTimeout: 10_000,
    env: {
      NODE_ENV: "test",
      // Deliberately unreachable — if a "unit" test forgets to mock something and code tries a
      // real connection, it should fail fast and loudly, never silently touch a real database.
      DATABASE_URL: "mysql://127.0.0.1:3306/no_db_should_ever_be_touched_by_unit_tests",
      CONTROL_DATABASE_URL: "mysql://127.0.0.1:3306/no_db_should_ever_be_touched_by_unit_tests",
      JWT_ACCESS_SECRET: "unit-test-access-secret-not-for-real-use-0123456789",
      JWT_REFRESH_SECRET: "unit-test-refresh-secret-not-for-real-use-0123456789",
      PLATFORM_ADMIN_JWT_SECRET: "unit-test-platform-admin-secret-not-for-real-use-0123456789",
      ENCRYPTION_KEY: "6e74a4d4d87c469904ac4d9f7cd499934a54566bf7b8ee322364b36e60f84458",
      WEB_ORIGIN: "http://localhost:5173",
      APP_BASE_URL: "http://localhost:5173",
      DEFAULT_ORG_SLUG: "default",
      // Non-empty so ai.service.ts#resolveApiKey's fallback doesn't 503 before ever reaching
      // the mocked SDK — the Anthropic client itself is mocked in AI unit tests, so this value
      // is never actually sent anywhere.
      ANTHROPIC_API_KEY: "test-anthropic-key-not-a-real-credential"
    }
  }
});
