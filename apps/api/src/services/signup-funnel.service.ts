/**
 * WHAT: one row per stage a signup reached (`SignupAttempt`) — the funnel the console's Signups page
 * draws and the daily summary counts (signup Phase 1, docs/SIGNUP_AND_DOMAINS_PLAN.md §5.5).
 *
 * WHAT IT KEEPS: the company domain and a KEYED hash of the address (`directoryHash`, the same key
 * the workspace finder uses), never the address. A created workspace already records its owner on
 * `Organization.ownerEmail`; everybody else is somebody who chose not to become a customer, and the
 * control plane has no business keeping a list of them. The hash is enough to count one person once.
 *
 * NEVER THROWS. It is called from inside signup, after the thing it records has happened; a
 * control-plane hiccup here must cost a row in a chart, not the customer's signup.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { companyDomainOf } from "../utils/company-domain.js";
import { emailDomainOf } from "../utils/free-mail-domains.js";
import { directoryHash } from "./workspace-directory.service.js";

/** `EXISTING_MEMBER`: verified, and the address already belongs to a workspace — somebody signing in
 *  through the signup page, not a prospect. Recorded so the funnel can tell the two apart. */
export type SignupStage = "CODE_SENT" | "REFUSED" | "VERIFIED" | "EXISTING_MEMBER" | "CREATED" | "JOIN_REQUESTED" | "UNAVAILABLE" | "FAILED";

const DETAIL_MAX = 500;

export async function recordSignupStage(
  stage: SignupStage,
  args: { email?: string; organizationId?: string | null; detail?: string | null }
): Promise<void> {
  try {
    await controlPrisma.signupAttempt.create({
      data: {
        stage,
        // The company domain when there is one; otherwise the literal domain, so a refusal of a
        // personal provider is still countable by provider ("how many tried with rediffmail?").
        domain: args.email ? (companyDomainOf(args.email) ?? (emailDomainOf(args.email) || null)) : null,
        emailHash: args.email ? directoryHash(args.email) : null,
        organizationId: args.organizationId ?? null,
        detail: args.detail ? args.detail.slice(0, DETAIL_MAX) : null
      }
    });
  } catch (error) {
    console.warn(`[signup] could not record the ${stage} stage:`, (error as Error).message);
  }
}
