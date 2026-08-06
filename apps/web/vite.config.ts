import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { createLogger, defineConfig, loadEnv } from "vite";

/**
 * `npm run dev` starts Vite (~1s) well before the API finishes booting (Prisma clients + face
 * model warm-up take several seconds), so any already-open tab's first heartbeats hit the proxy
 * with nothing listening and Vite prints a full AggregateError stack per request — which reads
 * exactly like an outage and is nothing of the sort. Collapse those into one throttled line.
 * A genuinely dead API still surfaces: the line repeats every 5s for as long as it stays true.
 */
const quietProxyLogger = createLogger();
const originalError = quietProxyLogger.error.bind(quietProxyLogger);
let lastProxyNoteAt = 0;
quietProxyLogger.error = (msg, options) => {
  if (typeof msg === "string" && msg.includes("http proxy error")) {
    const now = Date.now();
    if (now - lastProxyNoteAt > 5_000) {
      lastProxyNoteAt = now;
      quietProxyLogger.info("[dev] API not reachable yet — the proxy retries as requests arrive (normal during the first seconds of `npm run dev`; a message repeating past that means the API is actually down).");
    }
    return;
  }
  originalError(msg, options);
};

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
    // No certs → http, and SAY WHY: certificates are per-machine private keys (git-ignored),
    // so every fresh clone lands here — which reads as "https is missing" unless the terminal
    // explains itself. The camera on other devices needs https; localhost is exempt.
    console.log(
      "[vite] Serving over http — no certificate at apps/web/certs/ (per-machine, git-ignored)." +
        " For https + LAN camera access run `npm run certs`, then restart. Docs: DEPLOYMENT.md § Serving over HTTPS."
    );
  }

  return {
    plugins: [react()],
    customLogger: quietProxyLogger,
    define: {
      __APP_VERSION__: JSON.stringify(bundleVersion)
    },
    server: {
      host: true,
      port: 5173,
      // Strict on purpose: with this false, a second `npm run dev` silently came up on 5174 —
      // proxying to whichever API instance survived — and the machine accumulated half-dead
      // stacks that all LOOKED like the app. Failing loudly ("port in use") pairs with the API's
      // own EADDRINUSE guard: one running stack, or a clear message.
      strictPort: true,
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
