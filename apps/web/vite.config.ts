import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * Same-origin dev story:
 *
 *  - Vite binds 0.0.0.0:5173 (set via `--host 0.0.0.0` in package.json).
 *  - From any device on the LAN, the SPA loads at http://<dev-machine-ip>:5173.
 *  - `/api/*` and `/uploads/*` are proxied to the API server, so the browser
 *    always sees a single origin — no CORS, no per-device VITE_API_URL.
 *  - The proxy target is configurable via API_PROXY_TARGET, defaulting to
 *    http://localhost:4000 (the API's local port).
 *
 * In production, deploy the SPA and the API behind the same reverse proxy
 * (nginx / Caddy / Cloudflare) so the relative `/api` paths in
 * `services/api.ts` keep working without any client changes.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.API_PROXY_TARGET ?? "http://localhost:4000";

  // The version baked into THIS bundle, from the repo-root VERSION file (the single source the
  // API also reads — see apps/api/src/config/version.ts for why one file rules them all). The
  // update-refresh flow compares this constant against the version the server reports on
  // /api/health: a mismatch means the server was upgraded underneath a still-open tab.
  // APP_VERSION env wins so Docker builds can stamp without a VERSION file in context.
  let bundleVersion = process.env.APP_VERSION ?? env.APP_VERSION ?? "0.0.0-dev";
  if (!process.env.APP_VERSION && !env.APP_VERSION) {
    try {
      bundleVersion = readFileSync(resolve(__dirname, "../../VERSION"), "utf8").trim();
    } catch {
      /* dev fallback stands */
    }
  }

  return {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(bundleVersion)
    },
    server: {
      host: true,
      port: 5173,
      strictPort: false,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          secure: false
        },
        "/uploads": {
          target: apiTarget,
          changeOrigin: true,
          secure: false
        }
      }
    },
    preview: {
      host: true,
      port: 4173
    }
  };
});
