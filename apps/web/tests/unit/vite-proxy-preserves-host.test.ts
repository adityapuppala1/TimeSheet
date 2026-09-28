/**
 * The dev proxy must not rewrite the `Host` header.
 *
 * WHY A TEST OVER A CONFIG FILE, which is an unusual thing to assert: `Host` is the ONLY input the
 * API has for deciding which tenant a request belongs to (apps/api/src/middleware/tenant.ts — no org
 * id in the body, no header a client can set, because the workspace has to be known before any
 * credentials are exchanged). A proxy that rewrites it does not fail, warn, or look wrong. It
 * silently routes every request on this machine to `DEFAULT_ORG_SLUG`.
 *
 * WHAT ACTUALLY HAPPENED: `changeOrigin: true` sat in all four proxy entries. A login sent to
 * `https://localhost:5173/api/auth/login` carrying `Host: acme.example.test` returned a JWT whose
 * `org` claim was the DEFAULT organization's id, not Acme's. Subdomain routing had therefore never
 * once worked through a browser, and nobody noticed for the obvious reason: single-org development
 * is the case everybody runs, and it resolves to the default org whether or not `Host` survives.
 *
 * So the regression is invisible in the app, invisible in CI, and one word long. That is precisely
 * the shape that deserves an assertion on the configuration itself rather than on behaviour.
 */
import { describe, expect, it } from "vitest";

const configFactory = (await import("../../vite.config.js")).default as (env: {
  mode: string;
  command: string;
}) => {
  server: { proxy: Record<string, { changeOrigin?: boolean; target: string }> };
  preview: { proxy: Record<string, { changeOrigin?: boolean; target: string }> };
};

const config = configFactory({ mode: "development", command: "serve" });

/** Every proxy entry on both servers, as `"server /api"` → the entry, so a failure names the one. */
const allProxyEntries = Object.fromEntries(
  (["server", "preview"] as const).flatMap((which) =>
    Object.entries(config[which].proxy).map(([route, entry]) => [`${which} ${route}`, entry])
  )
);

describe("the Vite proxy and the Host header", () => {
  it("proxies both /api and /uploads on both the dev and the preview server", () => {
    // Guards the test itself: if a rename made `config.server.proxy` empty, every assertion below
    // would pass over nothing at all. This is the check that keeps the rest honest.
    expect(Object.keys(allProxyEntries).sort()).toEqual([
      "preview /api",
      "preview /uploads",
      "server /api",
      "server /uploads"
    ]);
  });

  it("never rewrites Host on any entry, because Host is the tenant", () => {
    for (const [name, entry] of Object.entries(allProxyEntries)) {
      // Falsy rather than `=== false`: omitting the key has the same effect, and a future edit that
      // deletes the line rather than flipping it is equally correct.
      expect(entry.changeOrigin, `${name} rewrites Host, which routes every request to DEFAULT_ORG_SLUG`).toBeFalsy();
    }
  });

  it("still points every entry at the API, not at the Vite server itself", () => {
    // The other half of a working proxy. Preserving Host while proxying nowhere is not an
    // improvement, and one mistake could produce that.
    for (const [name, entry] of Object.entries(allProxyEntries)) {
      expect(entry.target, name).toMatch(/^https?:\/\/[^/]+:\d+$/);
      expect(entry.target, name).not.toMatch(/:5173|:4173/);
    }
  });
});
