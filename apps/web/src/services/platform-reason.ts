/**
 * Reason-for-access, on the client side: which console requests must carry a justification, and
 * how the operator is asked for one.
 *
 * WHY THIS IS ONE INTERCEPTOR AND NOT A PARAMETER ON FIFTEEN API FUNCTIONS. A reason is metadata
 * about the request, not an argument to the operation — the server takes it in the
 * `X-Platform-Reason` header for exactly that reason (most of those routes validate `.strict()`
 * bodies, and the snapshot download has no body at all). Threading a `reason` argument through
 * every affected call site would mean touching a dozen pages, and the first route somebody adds
 * without it would silently 400 in production rather than failing where it was written. One
 * interceptor over one table means a new route is protected the moment it is added to the table
 * below, and every existing page keeps working unchanged.
 *
 * THE SERVER IS THE AUTHORITY, NOT THIS FILE. `requirePlatformReason` in
 * apps/api/src/middleware/platform-admin-auth.ts is what actually refuses a request without one.
 * This table exists so the operator is asked BEFORE the round trip instead of being shown a 400;
 * if the two drift, the server wins and the console shows its message.
 */

/**
 * `/backups/:id` and `/backups/:id/download` are snapshot routes, but `/backups/destinations`,
 * `/backups/policy/…`, `/backups/run/…` and friends live under the same prefix and are NOT
 * snapshots. Rules marked `snapshotOnly` skip anything matching this.
 */
const NOT_A_SNAPSHOT = /^\/backups\/(destinations|policy|run|sweep|runs|tick|overview)(\/|$)/;

/** Method + path-regex pairs, mirroring the routes that mount `requirePlatformReason`. */
const REASON_ROUTES: { method: string; pattern: RegExp; label: string; snapshotOnly?: true }[] = [
  { method: "PATCH", pattern: /^\/organizations\/[^/]+$/, label: "Change a workspace's plan, seats, name or status" },
  { method: "POST", pattern: /^\/organizations\/[^/]+\/provision$/, label: "Provision this workspace's database" },
  { method: "POST", pattern: /^\/organizations\/[^/]+\/restore-password-login$/, label: "Turn password sign-in back on for this workspace" },
  { method: "POST", pattern: /^\/organizations\/[^/]+\/reset-admin-password$/, label: "Reset this workspace's super admin password" },
  { method: "POST", pattern: /^\/email-log\/[^/]+\/resend$/, label: "Resend this email to the customer" },
  { method: "POST", pattern: /^\/retention\/run$/, label: "Run the retention programme now" },
  { method: "POST", pattern: /^\/retention\/[^/]+\/hold$/, label: "Change this workspace's retention hold" },
  { method: "POST", pattern: /^\/retention\/[^/]+\/send\//, label: "Send this retention email to the customer" },
  { method: "POST", pattern: /^\/retention\/[^/]+\/delete$/, label: "Delete this workspace and its database" },
  { method: "POST", pattern: /^\/maintenance\/broadcast$/, label: "Put workspaces into maintenance" },
  { method: "POST", pattern: /^\/monitoring\/[^/]+\/operation$/, label: "Run a maintenance operation on this database" },
  {
    method: "PUT",
    pattern: /^\/organizations\/[^/]+\/feature-overrides$/,
    // Named as what it can DO rather than as what it is called: the operator is about to hand a
    // workspace a capability its plan does not include, and the prompt is the last place that fact
    // is stated before it is recorded against their name.
    label: "Give this workspace an entitlement its plan does not include, or take one away"
  },
  { method: "GET", pattern: /^\/backups\/[^/]+\/download$/, label: "Download an entire copy of this workspace's database", snapshotOnly: true },
  { method: "POST", pattern: /^\/backups\/[^/]+\/restore$/, label: "Restore this snapshot over a workspace", snapshotOnly: true },
  { method: "DELETE", pattern: /^\/backups\/[^/]+$/, label: "Delete this snapshot", snapshotOnly: true },
  { method: "POST", pattern: /^\/backups\/run\//, label: "Take a backup of this workspace now" },
  { method: "POST", pattern: /^\/backups\/sweep\//, label: "Sweep this workspace's old backups" },
  { method: "POST", pattern: /^\/admins$/, label: "Create a platform admin account" },
  { method: "PATCH", pattern: /^\/admins\/[^/]+$/, label: "Change a platform admin's role or status" }
];

/** The label to prompt with, or null when this request needs no reason. */
export function reasonRequirementFor(method: string, url: string): string | null {
  // `/\/$/`, matching services/platform-admin-api.ts's own base-URL trim: one trailing slash is
  // the only case axios ever produces, and an anchored `+` quantifier is a linter flag for nothing.
  const path = (url.split("?")[0] || "").replace(/\/$/, "") || "/";
  const verb = method.toUpperCase();
  for (const route of REASON_ROUTES) {
    if (route.method !== verb) continue;
    if (route.snapshotOnly && NOT_A_SNAPSHOT.test(path)) continue;
    if (route.pattern.test(path)) return route.label;
  }
  return null;
}

type Asker = (label: string) => Promise<string | null>;

let asker: Asker | null = null;

/** Registered by the console layout's `<PlatformReasonPrompt />`, which owns the dialog. */
export function registerPlatformReasonAsker(fn: Asker | null) {
  asker = fn;
}

/**
 * Ask, and return what they typed — or null if they backed out, which cancels the request.
 *
 * The `window.prompt` fallback is for the case where a console request somehow fires with no
 * layout mounted. It is deliberately ugly: it should never be seen, and if it ever is, an operator
 * who is still asked for a reason is a better outcome than a request that quietly goes without one.
 */
export async function askPlatformReason(label: string): Promise<string | null> {
  if (asker) return asker(label);
  const typed = typeof window !== "undefined" ? window.prompt(`${label}.\n\nWhy? (recorded in the audit trail)`) : null;
  return typed && typed.trim().length >= 8 ? typed.trim() : null;
}

/** The header the API middleware reads. Named once so the two sides cannot drift. */
export const PLATFORM_REASON_HEADER = "X-Platform-Reason";
export const PLATFORM_REASON_MIN = 8;
