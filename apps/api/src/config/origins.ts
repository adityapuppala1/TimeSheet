/**
 * WHAT: the single definition of "may this origin talk to this API".
 *
 * WHY IT IS ITS OWN MODULE: two callers need this answer — the CORS middleware in `app.ts`, which
 * enforces it on every request, and the boot check in `deployment-check.ts`, which warns when a
 * deployment is addressed in a way that cannot work. They must agree, and the first version did not:
 * the check compared `APP_BASE_URL` against the literal `WEB_ORIGIN` list and knew nothing about the
 * development shortcut that accepts any private LAN address. So a fresh machine running
 * `APP_BASE_URL="auto"` — the normal, correct setup, whose whole point is adapting to whatever
 * address the new box has — booted with a loud ERROR about a configuration that was perfectly fine.
 *
 * A guard that cries on healthy deployments is worse than no guard. Rather than teach the check about
 * the rule, both now read the rule itself. This is the third time in one week that a rule living in
 * one caller and copied (or not) into another is what made two parts of this product disagree.
 */

/**
 * Loopback and the RFC 1918 ranges — everything that cannot be routed from the internet.
 *
 * This is what makes the development shortcut safe: "any private LAN address" cannot match a
 * stranger, because a stranger cannot reach one. A public address gets no such treatment in any
 * environment.
 *
 * `(?:[a-z0-9-]+\.)*localhost` AND NOT A BARE `localhost`, which is what this used to be. Testing a
 * second workspace on a development machine means browsing `acme.localhost:5173` — browsers resolve
 * every `*.localhost` name to loopback with no hosts-file entry, which is what RFC 6761 reserves the
 * name for. The bare pattern refused those, so the page LOADED (a same-origin GET sends no `Origin`
 * header at all) and then every sign-in answered 403 about an allow-list, which is a confusing place
 * to discover that subdomain routing is the thing you were testing. It is exactly as safe as the
 * bare form for the same reason: a name under `.localhost` cannot resolve anywhere but the machine
 * the browser is on, so it cannot match a stranger.
 */
export const PRIVATE_LAN_RE =
  /^https?:\/\/((?:[a-z0-9-]+\.)*localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/i;

/**
 * Whether an origin is one of THIS deployment's own workspaces.
 *
 * WHY A STATIC ALLOW-LIST CANNOT COVER MULTI-WORKSPACE, which is the bug this exists to fix. Every
 * workspace is served at its own hostname (`acme.example.com`), and a browser treats each of those
 * as a separate origin — so each one sends `Origin: https://acme.example.com` on every POST, even
 * though the request is same-origin from the page's point of view. `WEB_ORIGIN` is a fixed,
 * comma-separated list written at deploy time. You cannot enumerate your customers in it, and you
 * certainly cannot restart the API to add one. Left unfixed, CORS refuses every workspace except the
 * handful somebody remembered to list, and refuses them only on writes: the login page renders
 * perfectly and then cannot log anybody in.
 *
 * WHY THIS IS SAFE. `ROOT_DOMAIN` is operator configuration, and every name under it is under that
 * operator's own DNS control — a stranger cannot obtain `evil.example.com` without already owning
 * `example.com`. It grants no more trust than the router already extends: `middleware/tenant.ts`
 * accepts exactly these hostnames as naming a workspace, so a page served at one of them is by
 * definition one of this deployment's own pages.
 *
 * WHAT IS STILL CHECKED. The scheme and the port must match an entry the operator actually wrote in
 * `WEB_ORIGIN`. Without that, an https deployment would also accept `http://acme.example.com` and a
 * network attacker could downgrade a workspace to a plain-http origin the API then trusts. The
 * subdomain is what floats; the transport is not.
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER: a workspace on a VERIFIED CUSTOM DOMAIN (`time.acme.com`).
 * Those live in the control-plane database, and this function is synchronous and runs on every
 * request. Add each custom domain to `WEB_ORIGIN` when you verify it — see docs/DEPLOYMENT.md.
 */
export function isWorkspaceOrigin(origin: string, allowList: string[], rootDomain: string | undefined): boolean {
  const root = rootDomain?.trim().toLowerCase();
  if (!root) return false;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // The leading dot is load-bearing: without it `notexample.com` ends with `example.com` as a
  // string and a completely unrelated domain would be trusted as one of this deployment's own.
  if (!url.hostname.toLowerCase().endsWith(`.${root}`)) return false;

  // Scheme and port must match something the operator wrote down. `URL.port` is "" for a default
  // port, and both sides are compared as parsed URLs so `https://x.com` and `https://x.com:443`
  // cannot disagree about a port neither of them spells out.
  return allowList.some((entry) => {
    try {
      const allowed = new URL(entry);
      return allowed.protocol === url.protocol && allowed.port === url.port;
    } catch {
      return false;
    }
  });
}

/**
 * Whether one Origin header is allowed.
 *
 * The interesting cases are all boundaries on a security control: 172.16 is private and 172.32 is
 * not, an allow-list entry must match scheme AND host AND port because a browser treats those as
 * different origins, and a request with no Origin at all is not a cross-origin request — refusing it
 * would break every non-browser caller while protecting nothing.
 */
/**
 * A workspace reached on its OWN domain (`time.acme.com`), rather than on a subdomain of
 * `ROOT_DOMAIN`.
 *
 * Same trade as `isWorkspaceOrigin` and the same guard: the HOST may be anything the operator has
 * verified, and the scheme and port must still match an entry in `WEB_ORIGIN`. Verification proves
 * the customer controls that name (a DNS TXT record), which is the same bar `resolveCustomDomainSlug`
 * applies before routing a request there at all — so an origin this accepts is, by definition, a
 * page this deployment is already serving.
 */
function isCustomDomainOriginAllowed(
  origin: string,
  allowList: string[],
  isVerifiedDomain: ((hostname: string) => boolean) | undefined
): boolean {
  if (!isVerifiedDomain) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (!isVerifiedDomain(url.hostname)) return false;
  return allowList.some((entry) => {
    try {
      const allowed = new URL(entry);
      return allowed.protocol === url.protocol && allowed.port === url.port;
    } catch {
      return false;
    }
  });
}

/**
 * Does this origin have the SHAPE of a workspace address — three or more labels, not an IP?
 *
 * Used only to choose which refusal message to print, never to allow anything. A deployment that
 * has not set `ROOT_DOMAIN` refuses `acme.example.com` exactly as it always did; the difference is
 * that it now says which variable would accept it, instead of pointing at a list that cannot hold
 * every customer. The same distinction `config/deployment-check.ts` draws at boot.
 */
export function originLooksLikeWorkspace(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const { hostname } = new URL(origin);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false;
    return hostname.split(".").filter(Boolean).length >= 3 || hostname.toLowerCase().endsWith(".localhost");
  } catch {
    return false;
  }
}

/**
 * `isOriginAllowed`, asked about ONE request rather than about the deployment — what the CORS
 * middleware and the cookie-bearing auth routes use (middleware/origin-check.ts).
 *
 * The one difference is the `ROOT_DOMAIN` wildcard (security audit #13). A workspace origin is
 * allowed only when its hostname IS the request's Host: a page on `acme.<root>` may call
 * `acme.<root>/api`, never `beta.<root>/api`. Sibling subdomains are "same-site", so the SameSite=Lax
 * refresh cookie rides along on such a call, and the wildcard used to let one workspace's page read
 * another's access token out of `/auth/refresh`.
 *
 * Nothing legitimate needs the cross-workspace case: the SPA and API share one origin behind nginx
 * (`proxy_set_header Host $host`) and behind Vite in development, and the platform console and
 * split deployments are explicit `WEB_ORIGIN` entries, handled exactly as before. Hostnames only —
 * nginx's `$host` carries no port, and the scheme and port are already pinned against WEB_ORIGIN by
 * `isWorkspaceOrigin`.
 */
export function isOriginAllowedForHost(
  origin: string | undefined,
  /** The request's `Host` header, port and all — compared by hostname. */
  requestHost: string | undefined,
  allowList: string[],
  devMode: boolean,
  rootDomain?: string,
  isVerifiedDomain?: (hostname: string) => boolean
): boolean {
  if (!origin) return true;
  if (allowList.includes(origin)) return true;
  if (devMode && PRIVATE_LAN_RE.test(origin)) return true;
  if (isWorkspaceOrigin(origin, allowList, rootDomain)) {
    const requestHostname = (requestHost ?? "").split(":")[0].toLowerCase();
    return new URL(origin).hostname.toLowerCase() === requestHostname;
  }
  return isCustomDomainOriginAllowed(origin, allowList, isVerifiedDomain);
}

export function isOriginAllowed(
  origin: string | undefined,
  allowList: string[],
  devMode: boolean,
  /** `ROOT_DOMAIN`. When set, this deployment's own workspace subdomains are allowed — see
   *  `isWorkspaceOrigin` for why a static list cannot express that. */
  rootDomain?: string,
  /** "Is this hostname a verified custom domain?" — injected rather than imported so this module
   *  stays pure and testable, and so `deployment-check.ts` can ask the same question at boot
   *  without a control-plane round trip. Omitted means "no custom domains", which is correct for
   *  every single-org install. */
  isVerifiedDomain?: (hostname: string) => boolean
): boolean {
  if (!origin) return true;
  if (allowList.includes(origin)) return true;
  if (devMode && PRIVATE_LAN_RE.test(origin)) return true;
  if (isWorkspaceOrigin(origin, allowList, rootDomain)) return true;
  // A workspace on its own verified domain. Consulted last because it is the only branch that reads
  // state rather than configuration, and kept behind the same scheme/port rule as the others.
  return isCustomDomainOriginAllowed(origin, allowList, isVerifiedDomain);
}
