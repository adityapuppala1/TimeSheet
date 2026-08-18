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
 */
export const PRIVATE_LAN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/i;

/**
 * Whether one Origin header is allowed.
 *
 * The interesting cases are all boundaries on a security control: 172.16 is private and 172.32 is
 * not, an allow-list entry must match scheme AND host AND port because a browser treats those as
 * different origins, and a request with no Origin at all is not a cross-origin request — refusing it
 * would break every non-browser caller while protecting nothing.
 */
export function isOriginAllowed(origin: string | undefined, allowList: string[], devMode: boolean): boolean {
  if (!origin) return true;
  if (allowList.includes(origin)) return true;
  return devMode && PRIVATE_LAN_RE.test(origin);
}
