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

  // Read once, outside the returned config, so a missing pair is a silent no-op rather than a
  // crash on every request.
  const keyPath = env.DEV_HTTPS_KEY ?? resolve(__dirname, "certs/dev-key.pem");
  const certPath = env.DEV_HTTPS_CERT ?? resolve(__dirname, "certs/dev-cert.pem");
  let devHttps: { key: Buffer; cert: Buffer } | undefined;
  try {
    devHttps = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
    console.log(`[vite] HTTPS enabled using ${certPath}`);
  } catch {
    /* No certs, no HTTPS — the documented default. */
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
      /**
       * Optional HTTPS for the dev server, enabled by dropping a key/cert pair at
       * `apps/web/certs/` (or pointing DEV_HTTPS_KEY / DEV_HTTPS_CERT elsewhere).
       *
       * WHY THIS IS WORTH HAVING: the camera and every Copy button need a **secure context**.
       * Browsers exempt `localhost`, so on a laptop everything works over plain HTTP and the
       * problem is invisible — but a phone opening `http://<lan-ip>:5173` gets no camera at all,
       * and no amount of application code can change that. Testing the face flow on a real phone
       * therefore requires HTTPS even in development.
       *
       *   mkcert -install
       *   mkcert -key-file apps/web/certs/dev-key.pem -cert-file apps/web/certs/dev-cert.pem        *          localhost 192.168.1.20        # ...and whatever address the phone will use
       *
       * Absent the files this is simply undefined and the server stays on HTTP, so nobody who
       * does not need it has to care. See docs/DEPLOYMENT.md, "Serving over HTTPS".
       */
      https: devHttps,
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
