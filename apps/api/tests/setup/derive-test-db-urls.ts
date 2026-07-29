import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(API_ROOT, ".env") });

function withTestSuffix(url: string): string {
  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, "");
  parsed.pathname = `/${dbName}_test`;
  return parsed.toString();
}

/**
 * Derives throwaway `<db>_test` database URLs from the developer's own already-configured
 * `apps/api/.env` (same host/credentials the rest of this repo already uses, e.g. via
 * `npm run doctor`), rather than hardcoding a second set of credentials — works identically on
 * a local XAMPP install or a CI MySQL service container pointed at via the same env vars.
 */
export function deriveTestDbUrls(): { tenantUrl: string; controlUrl: string } {
  const baseTenant = process.env.DATABASE_URL;
  const baseControl = process.env.CONTROL_DATABASE_URL;
  if (!baseTenant || !baseControl) {
    throw new Error(
      "DATABASE_URL / CONTROL_DATABASE_URL must be set in apps/api/.env — the integration test " +
        "suite derives its own throwaway '<db>_test' databases from these (same host/credentials, different db name)."
    );
  }
  return { tenantUrl: withTestSuffix(baseTenant), controlUrl: withTestSuffix(baseControl) };
}
