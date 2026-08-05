/**
 * The one place the suite decides which scheme the dev server speaks.
 *
 * WHY THIS EXISTS: dropping a certificate pair at `apps/web/certs/` flips `npm run dev` to
 * HTTPS-only (vite.config.ts auto-detects it — that is the feature, see scripts/make-lan-certs).
 * Every hardcoded `http://localhost:5173` in the suite would then fail with a connection error
 * that looks nothing like its cause. So the base URL is derived from the same signal vite uses:
 * the presence of the cert files, checked from the repo root Playwright always runs in.
 *
 * `E2E_BASE_URL` still overrides everything — CI and remote targets keep working unchanged.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const devHttps =
  existsSync(resolve(process.cwd(), "apps/web/certs/dev-key.pem")) &&
  existsSync(resolve(process.cwd(), "apps/web/certs/dev-cert.pem"));

export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? (devHttps ? "https://localhost:5173" : "http://localhost:5173");
