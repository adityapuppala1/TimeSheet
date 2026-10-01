/**
 * WHAT: the deployment's self-serve signup policy — whether `/api/signup` creates workspaces at all,
 * which addresses it refuses, and who hears about it when it does (or fails to).
 *
 * WHY IT EXISTS (2026-10-01). Signup is the only public route in the product that provisions
 * infrastructure, and it was mounted on every deployment with no way to turn it off. Two things made
 * that worse than it sounds:
 *
 *  - `.env.example` ships `TENANT_DB_PROVISION_BASE_URL` set, so a manual install copied from the
 *    template would create a database for anyone with a company address.
 *  - Without `ROOT_DOMAIN` a new workspace has no address of its own: `workspaceUrlForSlug` falls
 *    back to `APP_BASE_URL`, which is the DEFAULT workspace. The new owner was handed a link to a
 *    workspace their account does not exist in, and a database nobody could reach was left behind.
 *
 * So signup is open only when BOTH hold: an operator switched it on, and the deployment routes
 * workspaces by subdomain. Off is the default; an operator who sells through signup turns it on once.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: decide what happens when a second person from the same company
 * signs up. Today that still creates a second workspace. Routing them to the existing one is Phase 1
 * of docs/SIGNUP_AND_DOMAINS_PLAN.md, and it needs tables this file does not own.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { env } from "../config/env.js";
import { emailDomainOf, isDisposableAddress, isFreeMailAddress } from "../utils/free-mail-domains.js";
import { getAlertSettings, resolveAlertRecipients } from "./platform-alerts.service.js";
import { platformAudit } from "./platform-audit.service.js";
import { sendPlatformTemplate } from "./platform-mail.service.js";

/** How operators hear about signups — decision 6 in docs/SIGNUP_AND_DOMAINS_PLAN.md. */
export type SignupNotifyMode = "DAILY" | "EACH" | "OFF";

export interface SignupSettings {
  enabled: boolean;
  blockedDomains: string[];
  notifyMode: SignupNotifyMode;
  /** Days before an unanswered join request expires (decision 7). */
  joinRequestTtlDays: number;
  /** Null until an operator first saves the policy — the defaults are not anybody's decision. */
  updatedBy: string | null;
  updatedAt: Date | null;
}

export const DEFAULT_SIGNUP_SETTINGS: Readonly<Pick<SignupSettings, "enabled" | "blockedDomains" | "notifyMode" | "joinRequestTtlDays">> =
  Object.freeze({
    enabled: false,
    blockedDomains: [],
    notifyMode: "DAILY",
    joinRequestTtlDays: 14
  });

const NOTIFY_MODES: readonly SignupNotifyMode[] = ["DAILY", "EACH", "OFF"];

/** An unknown stored value reads as the default, never as silence: a typo in the column must not
 *  quietly stop operators hearing about customers. */
function asNotifyMode(value: unknown): SignupNotifyMode {
  return NOTIFY_MODES.includes(value as SignupNotifyMode) ? (value as SignupNotifyMode) : "DAILY";
}

/** 1–90 days. Shorter than a day is a request nobody can answer; longer than a quarter is a request
 *  nobody will. A non-number reads as the default. */
function clampTtlDays(value: unknown): number {
  const days = Math.round(Number(value));
  if (!Number.isFinite(days)) return DEFAULT_SIGNUP_SETTINGS.joinRequestTtlDays;
  return Math.min(90, Math.max(1, days));
}

/** More than enough for a real deny-list; a cap so the JSON column cannot be used as storage. */
const MAX_BLOCKED_DOMAINS = 500;
const DOMAIN_SHAPE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Turns whatever an operator pasted into a clean, de-duplicated list of domains.
 *
 * Tolerant on purpose: people paste `@rediffmail.com`, `Rediffmail.com `, a whole address, or one
 * domain per line with commas. Anything that still is not a domain after that is dropped rather than
 * stored, because a junk entry would never match and would only make the list harder to read.
 */
export function normaliseDomainList(input: unknown): string[] {
  let raw: unknown[] = [];
  if (Array.isArray(input)) raw = input;
  else if (typeof input === "string") raw = input.split(/[\s,;]+/);
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const domain = trimTrailingDots(emailDomainOf(item.replace(/^@+/, "")));
    if (DOMAIN_SHAPE.test(domain)) out.add(domain);
    if (out.size >= MAX_BLOCKED_DOMAINS) break;
  }
  return [...out].sort();
}

/**
 * `example.com.` → `example.com`. A loop, not `/\.+$/`: that innocent-looking pattern is the one this
 * repo has MEASURED as quadratic on a long run of the repeated character (CONTRIBUTING.md, "the
 * rules that are questions") — and this input is pasted by a person, so its length is not ours.
 */
function trimTrailingDots(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === ".") end -= 1;
  return value.slice(0, end);
}

/** No row means the shipped defaults — reading never writes, so `updatedBy` stays honest. */
export async function getSignupSettings(): Promise<SignupSettings> {
  const row = await controlPrisma.platformSignupSettings.findUnique({ where: { id: "global" } });
  if (!row) return { ...DEFAULT_SIGNUP_SETTINGS, blockedDomains: [], updatedBy: null, updatedAt: null };
  return {
    enabled: row.enabled,
    blockedDomains: normaliseDomainList(row.blockedDomains),
    notifyMode: asNotifyMode(row.notifyMode),
    joinRequestTtlDays: clampTtlDays(row.joinRequestTtlDays),
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt
  };
}

export async function updateSignupSettings(
  /** `blockedDomains` may be a list or pasted text — normaliseDomainList cleans either. */
  patch: Partial<Pick<SignupSettings, "enabled" | "notifyMode" | "joinRequestTtlDays">> & { blockedDomains?: string[] | string },
  actorLabel: string
): Promise<SignupSettings> {
  const current = await getSignupSettings();
  const next = {
    enabled: patch.enabled ?? current.enabled,
    blockedDomains: patch.blockedDomains === undefined ? current.blockedDomains : normaliseDomainList(patch.blockedDomains),
    notifyMode: patch.notifyMode === undefined ? current.notifyMode : asNotifyMode(patch.notifyMode),
    joinRequestTtlDays: patch.joinRequestTtlDays === undefined ? current.joinRequestTtlDays : clampTtlDays(patch.joinRequestTtlDays)
  };
  await controlPrisma.platformSignupSettings.upsert({
    where: { id: "global" },
    create: { id: "global", ...next, updatedBy: actorLabel },
    update: { ...next, updatedBy: actorLabel }
  });
  // Recorded as what changed, not the whole row, so the audit reads as a decision ("signup opened")
  // rather than a dump. The domain list is recorded in full when it changes — who blocked what is
  // exactly the question somebody asks later.
  const changed: Record<string, unknown> = {};
  if (next.enabled !== current.enabled) changed.enabled = next.enabled;
  if (next.notifyMode !== current.notifyMode) changed.notifyMode = next.notifyMode;
  if (next.joinRequestTtlDays !== current.joinRequestTtlDays) changed.joinRequestTtlDays = next.joinRequestTtlDays;
  if (next.blockedDomains.join(",") !== current.blockedDomains.join(",")) changed.blockedDomains = next.blockedDomains;
  await platformAudit("PLATFORM_ADMIN", actorLabel, "signup.settings_updated", "PlatformSignupSettings", "global", changed);
  return getSignupSettings();
}

export type SignupAvailability =
  | { open: true }
  /** `disabled` — an operator has not switched it on. `single-org` — no `ROOT_DOMAIN`, so a new
   *  workspace would have no address. `unavailable` — the policy could not be read. */
  | { open: false; reason: "disabled" | "single-org" | "unavailable" };

/** Whether this deployment routes workspaces by subdomain — the precondition for signup at all. */
export function hasMultiOrgRouting(): boolean {
  return Boolean(env.ROOT_DOMAIN);
}

/** Pure, so the rule is testable without a database: both conditions, single-org checked first. */
export function availabilityFrom(settings: Pick<SignupSettings, "enabled">, rootDomain: string | undefined | null): SignupAvailability {
  if (!rootDomain) return { open: false, reason: "single-org" };
  if (!settings.enabled) return { open: false, reason: "disabled" };
  return { open: true };
}

/**
 * Fails CLOSED. Unlike the maintenance gate, which fails open because locking a workforce out is the
 * worse outcome, the thing behind this one creates a database: a control-plane hiccup must not turn
 * into "signup is open" for its duration.
 */
export async function getSignupAvailability(): Promise<SignupAvailability> {
  try {
    return availabilityFrom(await getSignupSettings(), env.ROOT_DOMAIN);
  } catch (error) {
    console.error("[signup] could not read the signup policy; refusing signups until it can be read:", (error as Error).message);
    return { open: false, reason: "unavailable" };
  }
}

/**
 * Why this address may not start a workspace, or null if it may.
 *
 * Personal and operator-blocked domains get the same message, deliberately: telling a stranger which
 * domains an operator has listed would publish the list. A throwaway inbox gets its own, because the
 * fix is different — there is no "work" version of a ten-minute inbox to switch to.
 */
export function signupRefusalFor(email: string, blockedDomains: readonly string[]): string | null {
  if (isDisposableAddress(email)) return "That looks like a temporary inbox. Use your work email address — a workspace belongs to a company.";
  if (isFreeMailAddress(email) || blockedDomains.includes(emailDomainOf(email))) {
    return "Use your work email address — a workspace belongs to a company, not to a personal inbox.";
  }
  return null;
}

export type SignupOutcome =
  | { kind: "created"; organizationId: string; workspaceName: string; slug: string; ownerEmail: string; workspaceUrl: string; trialEndsAt: Date | null; trialTier: string }
  | { kind: "failed"; workspaceName: string; slug: string; ownerEmail: string; error: string };

const formatDay = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : "—");

/**
 * Tells the operators. Best-effort and NEVER throws: by the time this runs the workspace either
 * exists or has been cleaned up, and a mail relay that is down must not turn a successful signup into
 * a 500 for the new customer, or a failed one into a second, more confusing error.
 *
 * Recipients are the console's alert recipients (an explicit list, else every active platform admin)
 * — the same people who hear about fleet alerts, so there is one roster to keep current, not two.
 */
export async function notifySignupOutcome(outcome: SignupOutcome): Promise<void> {
  try {
    const settings = await getSignupSettings();
    // Per-signup email only in EACH mode. DAILY leaves it to the summary (signup-digest.service.ts),
    // which reads the audit and funnel rows this route writes either way.
    if (settings.notifyMode !== "EACH") return;
    const recipients = await resolveAlertRecipients(await getAlertSettings());
    if (!recipients.length) return;

    const base = env.APP_BASE_URL.replace(/\/$/, "");
    const vars =
      outcome.kind === "created"
        ? {
            workspaceName: outcome.workspaceName,
            slug: outcome.slug,
            ownerEmail: outcome.ownerEmail,
            domain: emailDomainOf(outcome.ownerEmail),
            workspaceUrl: outcome.workspaceUrl,
            trialTier: outcome.trialTier,
            trialEndsAt: formatDay(outcome.trialEndsAt),
            consoleUrl: `${base}/platform-admin/organizations/${outcome.organizationId}`
          }
        : {
            workspaceName: outcome.workspaceName,
            slug: outcome.slug,
            ownerEmail: outcome.ownerEmail,
            domain: emailDomainOf(outcome.ownerEmail),
            error: outcome.error,
            consoleUrl: `${base}/platform-admin/organizations`
          };
    const key = outcome.kind === "created" ? "platform.signup_created" : "platform.signup_failed";
    for (const to of recipients) {
      await sendPlatformTemplate(key, {
        to,
        vars,
        organizationId: outcome.kind === "created" ? outcome.organizationId : null
      }).catch((error: Error) => console.warn(`[signup] could not notify ${to} about a signup:`, error.message));
    }
  } catch (error) {
    console.warn("[signup] operator notification skipped:", (error as Error).message);
  }
}
