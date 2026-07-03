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

  return {
    plugins: [react()],
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
