/**
 * WHAT: the decisions the signup page makes from what the server tells it (signup Phase 1,
 * docs/SIGNUP_AND_DOMAINS_PLAN.md §5.1). Pure, so tests/unit/signup-flow.test.ts pins each one.
 *
 * WHY HERE AND NOT IN Signup.tsx: every branch is a door — sign in, ask to join, wait, create — and
 * a wrong branch offers the wrong one. A component test would need the whole page mounted to check
 * a one-line mapping; these are the mappings.
 */

export interface SignupWorkspaceLink {
  slug: string;
  name: string;
  url: string;
}

/** What `POST /api/signup/verify` answers. Only `join` and `create` carry a continuation: the code is
 *  spent at verify, and the continuation is what the next step redeems. */
export type SignupVerifyResult =
  | { next: "member"; workspaces: SignupWorkspaceLink[] }
  | { next: "join"; workspace: { name: string }; continuation: string }
  | { next: "unavailable"; workspace: { name: string } }
  | { next: "create"; continuation: string };

export type SignupStep = "email" | "code" | "member" | "join" | "joined" | "unavailable" | "workspace" | "done";

export function stepAfterVerify(result: SignupVerifyResult): SignupStep {
  if (result.next === "create") return "workspace";
  return result.next;
}

/**
 * `.<rootDomain>` for the address preview, or null when the server names none. Never derived from
 * `window.location`: the page is served from the apex AND from any workspace's own host, and
 * stripping a label guesses wrong on one of them.
 */
export function workspaceHostSuffix(rootDomain: string | null | undefined): string | null {
  const domain = rootDomain?.trim().toLowerCase().replace(/\.$/, "");
  return domain ? `.${domain}` : null;
}

export type SignupErrorAction =
  | { kind: "closed" }
  | { kind: "slug-taken"; message: string }
  | { kind: "verify-again"; message: string }
  | { kind: "unavailable" }
  | { kind: "expired"; message: string }
  | { kind: "message"; message: string };

/** Where a refusal belongs: on the field, back at a step, or as a line under the form. */
export function classifySignupError(error: unknown, fallback = "Something went wrong. Try again."): SignupErrorAction {
  const response = (error as { response?: { status?: number; data?: { code?: string; message?: string } } })?.response;
  const code = response?.data?.code;
  const message = response?.data?.message;
  if (code === "SIGNUP_CLOSED") return { kind: "closed" };
  if (code === "SLUG_TAKEN") return { kind: "slug-taken", message: message ?? "That workspace address is already taken." };
  // The code was spent at verify, so "back" means a fresh code — and a fresh decision: a domain
  // claimed since then turns create into join; a company workspace gone since then turns join into create.
  if (code === "DOMAIN_CLAIMED" || code === "NO_WORKSPACE") return { kind: "verify-again", message: message ?? "Things changed since you verified. Verify again." };
  if (code === "WORKSPACE_UNAVAILABLE") return { kind: "unavailable" };
  if (code === "SIGNUP_EXPIRED") return { kind: "expired", message: message ?? "Your email verification has expired. Start again." };
  // The limiter answers with express-rate-limit's default body; "Couldn't send" for something that
  // will work again shortly reads as broken rather than as throttled.
  if (response?.status === 429 && !message) return { kind: "message", message: "Too many signup attempts from this network. Wait a few minutes and try again." };
  return { kind: "message", message: message ?? fallback };
}

/** "Northwind's workspace", or "Your company's workspace" when the server did not name it — a
 *  WORKSPACE_UNAVAILABLE from /complete carries no name, and "'s workspace" is not a sentence. */
export function companyWorkspaceLabel(companyName: string): string {
  return companyName ? `${companyName}'s workspace` : "Your company's workspace";
}

/** The opening line of the Contact form's message for a known `?reason=`. A closed set: the value is
 *  off a URL, and an unknown one starts the message empty rather than echoing it. */
export function contactPrefill(reason: string | null): string {
  if (reason === "separate-workspace") {
    return "Our company already has a TimeSphere workspace, and we need a separate workspace for our team. ";
  }
  return "";
}
