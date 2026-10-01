/**
 * Self-serve signup — the route behind "Start free trial", which until now went to `/login`, where
 * there is no way to create a workspace.
 *
 * THIS IS THE ONLY PUBLIC ROUTE IN THE PRODUCT THAT CREATES INFRASTRUCTURE. Everything else an
 * anonymous caller can reach reads, or writes a row. This one creates a MySQL database, runs every
 * migration against it, and seeds it — so the guards here are doing more work than the ones on any
 * other public endpoint, and each is worth naming:
 *
 *  - CLOSED UNLESS OPENED. An operator switches signup on, and only on a deployment that gives each
 *    workspace its own address (platform-signup.service.ts). Checked on every step.
 *  - VERIFY-FIRST. Nothing is revealed and nothing is provisioned until a code sent to the address
 *    comes back. Without it, one POST creates a database, and a script creates a thousand.
 *  - NO PERSONAL DOMAINS. A trial is per organisation; gmail.com is not one.
 *  - ONE WORKSPACE PER COMPANY (Phase 1, docs/SIGNUP_AND_DOMAINS_PLAN.md). The code is checked once,
 *    at /verify, and the answer is a decision: you already belong to a workspace; your company has
 *    one, ask to join it; your company's workspace is unavailable; or create one. The unique claim on
 *    the company domain is what makes "create" safe against two colleagues racing.
 *  - SLUG COLLISIONS ARE A 409, NEVER A SILENT SUFFIX — and, since Phase 1, they no longer burn the
 *    person's verification: /verify exchanges the single-use code for a continuation that the form
 *    can retry with.
 *  - MOUNTED WITHOUT TENANT RESOLUTION. There is no tenant yet — that is the point — so this router
 *    is registered before `resolveTenant`, like the webhook receivers.
 *
 * WHAT IT DOES NOT DO: take payment. The trial is real and free; the card is asked for at the end,
 * from inside the workspace, by the same billing flow an upgrade already uses.
 */
import { SELF_SERVE_TRIAL_DAYS, SELF_SERVE_TRIAL_TIER } from "@timesheet/shared";
import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { controlPrisma } from "../config/control-prisma.js";
import { env } from "../config/env.js";
import { withOrgTenant } from "../config/with-org-tenant.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { claimDomainInTransaction, DomainAlreadyClaimedError, findClaimForEmail } from "../services/company-domain-claims.service.js";
import { templates } from "../services/mail-templates.js";
import { dispatchTransactional } from "../services/notify.service.js";
import { platformAudit } from "../services/platform-audit.service.js";
import { sendPlatformTemplate } from "../services/platform-mail.service.js";
import { getSignupAvailability, getSignupSettings, notifySignupOutcome, signupRefusalFor } from "../services/platform-signup.service.js";
import { provisionOrganization } from "../services/provisioning.service.js";
import { recordSignupStage } from "../services/signup-funnel.service.js";
import {
  checkVerificationCode,
  findWorkspacesForEmail,
  issueSignupContinuation,
  issueVerificationCode,
  peekSignupContinuation,
  redeemSignupContinuation,
  rememberWorkspaceMembership,
  workspaceUrlForSlug
} from "../services/workspace-directory.service.js";
import { companyDomainOf } from "../utils/company-domain.js";

export const signupRouter = Router();

/** How long a self-serve trial runs — `SELF_SERVE_TRIAL_DAYS` in @timesheet/shared, because the
 *  landing page and the signup page state it too and had drifted to 14 against this route's 15. */
const TRIAL_DAYS = SELF_SERVE_TRIAL_DAYS;

/**
 * Refuses unless signup is open on this deployment — see platform-signup.service.ts for the two
 * conditions. Checked on EVERY step: the switch can be turned off between someone requesting a code
 * and returning it, and "off" has to mean no new database from that moment.
 *
 * 403 with a machine-readable code, so the page can show the closed state rather than an error. The
 * message names no reason: whether this is a single-org install is not a stranger's business.
 */
async function assertSignupOpen(): Promise<void> {
  const availability = await getSignupAvailability();
  if (!availability.open) {
    throw new AppError(403, "Self-serve signup is closed on this deployment. Contact us and we'll set up your workspace.", { code: "SIGNUP_CLOSED" });
  }
}

/** Personal, temporary, operator-blocked — or no company domain at all (an IP, `localhost`, a bare
 *  public suffix): nothing a company could be identified by. Recorded as REFUSED for the funnel. */
async function refuseIfNotACompany(email: string): Promise<void> {
  const refusal =
    signupRefusalFor(email, (await getSignupSettings()).blockedDomains) ??
    (companyDomainOf(email) ? null : "Use your work email address — a workspace belongs to a company, not to a personal inbox.");
  if (refusal) {
    await recordSignupStage("REFUSED", { email, detail: refusal });
    throw new AppError(422, refusal);
  }
}

/**
 * GET /api/signup/status — whether "Start free trial" should be offered at all, and the domain a new
 * workspace's address hangs off (null on a single-org install) so the page can show the real one.
 *
 * Mounted in app.ts AHEAD of the signup router's own limiter (five an hour), because the landing page
 * asks on every visit and must not spend the budget a real signup needs. Public by nature: the
 * landing page already shows or hides the button, and the root domain is in every workspace's URL.
 */
export async function signupStatusHandler(_req: Request, res: Response): Promise<void> {
  const availability = await getSignupAvailability();
  res.json({ open: availability.open, trialDays: TRIAL_DAYS, trialTier: SELF_SERVE_TRIAL_TIER, rootDomain: env.ROOT_DOMAIN || null });
}

/* The list of "this address is a person, not an organisation" domains moved to
 * utils/free-mail-domains.ts in 4.0.0, when the sales contact form became the SECOND caller — and
 * the one that reaches the opposite conclusion from the same fact. Signup refuses a free-mail
 * address (a trial provisions a database, so one address anybody can make in ten seconds is not an
 * organisation); a sales enquiry from the same address is flagged and kept, because there is no
 * infrastructure behind a contact form and a founder on Gmail is a real lead. Two copies of the
 * list would have drifted the moment either side learned a new domain. */

/** Slugs that must never become a workspace: they would shadow a real hostname on the deployment. */
const RESERVED_SLUGS = new Set(["www", "app", "api", "admin", "platform-admin", "mail", "smtp", "status", "docs", "help", "support", "static", "cdn", "assets"]);

function slugProblem(slug: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(slug)) {
    return "Use 3–63 characters: lowercase letters, numbers and hyphens, starting and ending with a letter or number.";
  }
  if (RESERVED_SLUGS.has(slug)) return "That address is reserved. Try another.";
  return null;
}

const EXPIRED = () =>
  new AppError(400, "Your email verification has expired. Start again with your work email — it only takes a minute.", { code: "SIGNUP_EXPIRED" });

/* ------------------------------------------------------------------ *
 * Step 1 — prove the address
 * ------------------------------------------------------------------ */

signupRouter.post(
  "/start",
  validate(z.object({ body: z.object({ email: z.string().email().max(255) }) })),
  async (req, res) => {
    await assertSignupOpen();
    const email = req.body.email.trim().toLowerCase();
    // Named plainly rather than hidden behind a generic error: this one IS worth telling the person,
    // because it is a mistake they can fix in five seconds, not an enumeration signal.
    await refuseIfNotACompany(email);

    const { token, code } = await issueVerificationCode(email, "signup");
    // `sendPlatformMail`, NOT `dispatchTransactional`. There is no workspace yet — that is what
    // this route is for — and the normal path resolves an SMTP transport per tenant and writes an
    // EmailLog row through the tenant-scoped Prisma proxy. Using it here threw "No tenant context
    // is active" on the very first live request, which is the same trap `send-test-email.ts` fell
    // into. See platform-mail.service.ts for what this gives up in exchange.
    // The registered template rather than a raw body, so the code email is editable, previewable
    // and counted in the console like every other platform email. `throwOnFailure` keeps the
    // original contract: a person is watching this request, and "check your email" on a message
    // that did not go is the worst answer.
    await sendPlatformTemplate("signup.verify", { to: email, vars: { code }, throwOnFailure: true });
    await recordSignupStage("CODE_SENT", { email });

    res.status(202).json({ token, message: "Check your email for a 6-digit code." });
  }
);

/* ------------------------------------------------------------------ *
 * Step 2 — check the code once, and decide
 * ------------------------------------------------------------------ */

/**
 * The code is checked HERE, once, and only after it is returned does the person learn anything about
 * any workspace — the same verify-first rule "Find your workspace" follows, because "acme.com has a
 * workspace" told to anyone who types an @acme.com address would enumerate customers.
 *
 * The answer (decision table, docs/SIGNUP_AND_DOMAINS_PLAN.md §5.1):
 *  - member      — the address already belongs to a workspace: sign in, nothing is created.
 *  - join        — an ACTIVE workspace holds the company domain: ask to join it. Only its NAME is
 *                  returned; its address, admins and size are none of a requester's business yet.
 *  - unavailable — the company's workspace is in grace, suspended or still provisioning (decision 8):
 *                  no request, and no second workspace for the domain either.
 *  - create      — the company has no workspace.
 * `join` and `create` carry a continuation: the single-use code is spent here, and the continuation
 * is what the next step redeems.
 */
signupRouter.post(
  "/verify",
  validate(z.object({ body: z.object({ token: z.string().min(1).max(200), code: z.string().min(4).max(12) }) })),
  async (req, res) => {
    await assertSignupOpen();
    const check = await checkVerificationCode(req.body.token, req.body.code, "signup");
    if (!check.ok) {
      throw check.reason === "exhausted"
        ? new AppError(429, "Too many attempts. Request a new code.")
        : new AppError(400, "That code isn't right, or it has expired. Request a new one.");
    }
    const email = check.email;
    await refuseIfNotACompany(email);
    await recordSignupStage("VERIFIED", { email });

    const workspaces = await findWorkspacesForEmail(email);
    if (workspaces.length > 0) {
      res.json({ next: "member", workspaces });
      return;
    }

    const claim = await findClaimForEmail(email);
    if (claim && claim.organization.status !== "ACTIVE") {
      await recordSignupStage("UNAVAILABLE", { email, organizationId: claim.organization.id, detail: claim.organization.status });
      res.json({ next: "unavailable", workspace: { name: claim.organization.name } });
      return;
    }
    const continuation = await issueSignupContinuation(email);
    if (claim) {
      res.json({ next: "join", workspace: { name: claim.organization.name }, continuation });
      return;
    }
    res.json({ next: "create", continuation });
  }
);

/* ------------------------------------------------------------------ *
 * Step 3a — create the workspace
 * ------------------------------------------------------------------ */

signupRouter.post(
  "/complete",
  validate(
    z.object({
      body: z.object({
        continuation: z.string().min(3).max(200),
        workspaceName: z.string().min(2).max(200),
        slug: z.string().min(3).max(63),
        adminName: z.string().min(2).max(120),
        adminPassword: z.string().min(8).max(200)
      })
    })
  ),
  async (req, res) => {
    await assertSignupOpen();
    // PEEKED, not redeemed: everything that can be corrected — a taken or malformed address — is
    // checked before the continuation is spent, so fixing it costs the person nothing.
    const proof = await peekSignupContinuation(req.body.continuation);
    if (!proof.ok) throw EXPIRED();
    const email = proof.email;
    // Again, against the PROVEN address: an operator may have blocked its domain since the code was
    // sent, and the proven address — not anything this request supplies — is the one the workspace
    // is created for.
    await refuseIfNotACompany(email);
    const domain = companyDomainOf(email)!;

    const slug = req.body.slug.trim().toLowerCase();
    const problem = slugProblem(slug);
    if (problem) throw new AppError(422, problem);
    const taken = await controlPrisma.organization.findUnique({ where: { slug }, select: { id: true } });
    if (taken) throw new AppError(409, "That workspace address is already taken. Try another.", { code: "SLUG_TAKEN" });

    const now = new Date();
    let org: Awaited<ReturnType<typeof controlPrisma.organization.create>>;
    try {
      // The workspace row and its company's domain claim, together: if somebody from the same
      // company won the claim a moment ago, the unique key refuses ours and the transaction takes
      // our workspace row back with it — nothing is left half-created.
      org = await controlPrisma.$transaction(async (tx) => {
        const created = await tx.organization.create({
          data: {
            name: req.body.workspaceName.trim(),
            slug,
            status: "PROVISIONING",
            // planTier stays STARTER — what they have PAID for. The trial grants Team on top of it, and
            // keeping the two apart is what lets the trial expire without guessing what to fall back to.
            planTier: "STARTER",
            trialTier: SELF_SERVE_TRIAL_TIER,
            createdVia: "SELF_SERVE",
            // The retention programme writes to this address after the workspace is suspended, and
            // after it is deleted — neither is a moment to go looking inside the tenant database.
            ownerEmail: email,
            trialStartedAt: now,
            trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000)
          }
        });
        await claimDomainInTransaction(tx, domain, created.id, "SIGNUP");
        return created;
      });
    } catch (error) {
      if (error instanceof DomainAlreadyClaimedError) {
        throw new AppError(409, "Someone from your company has just created a workspace. Verify again and you can ask to join it.", {
          code: "DOMAIN_CLAIMED"
        });
      }
      // The same race on the address itself: the pre-check above passed for both requests.
      if ((error as { code?: string }).code === "P2002") {
        throw new AppError(409, "That workspace address is already taken. Try another.", { code: "SLUG_TAKEN" });
      }
      throw error;
    }

    // Spent only now, when a workspace exists for it. A continuation redeemed in the meantime by a
    // second request (a double click, two tabs) loses: its workspace row is taken back.
    if (!(await redeemSignupContinuation(req.body.continuation))) {
      await controlPrisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
      throw EXPIRED();
    }

    try {
      // Synchronous, and it takes a while — it creates a database and runs every migration. Done
      // inline anyway because the alternative is handing back a workspace URL that 503s for the
      // next thirty seconds, which reads as a broken signup on the one page where first impressions
      // are the entire product.
      await provisionOrganization(org.id, {
        adminEmail: email,
        adminName: req.body.adminName.trim(),
        adminPassword: req.body.adminPassword
      });
    } catch (error) {
      // A half-provisioned org would sit in PROVISIONING forever, holding its slug hostage and
      // answering 503 to anybody who tried it. Removing the registration is the honest cleanup — its
      // domain claim goes with it (ON DELETE CASCADE), so the company can try again. The physical
      // database, if it got that far, is left for an operator, because deleting a database
      // automatically in an error path is how the wrong one gets dropped.
      await controlPrisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
      const detail = (error as Error).message;
      console.error(`[signup] provisioning failed for "${slug}" (${domain}):`, detail);
      // The operators get the detail; the person gets an apology. The raw message used to be shown
      // to them, and a provisioning error is infrastructure talking — database names, grants, hosts —
      // to a stranger on a public page.
      await platformAudit("CUSTOMER", email, "org.signup_failed", "Organization", null, {
        slug,
        workspaceName: req.body.workspaceName.trim(),
        domain,
        error: detail.slice(0, 500)
      });
      await recordSignupStage("FAILED", { email, detail });
      await notifySignupOutcome({ kind: "failed", workspaceName: req.body.workspaceName.trim(), slug, ownerEmail: email, error: detail });
      throw new AppError(502, "We couldn't finish setting up your workspace. Our team has been notified and will be in touch — you can also try again in a few minutes.");
    }

    // So the finder can route them here next time without waiting for a first sign-in.
    await rememberWorkspaceMembership(org.id, email);

    await withOrgTenant(slug, async () => {
      await dispatchTransactional({
        to: email,
        templateKey: "welcome",
        vars: { name: req.body.adminName.trim(), appUrl: workspaceUrlForSlug(slug) },
        fallback: { subject: "Welcome to TimeSphere", html: templates.welcome(req.body.adminName.trim()) }
      });
    });

    // So the console's Recent activity shows a new customer the moment they arrive — before Phase 0,
    // a self-serve workspace appeared in no activity feed at all, only as one more row in the list.
    await platformAudit("CUSTOMER", email, "org.signup_completed", "Organization", org.id, {
      slug,
      workspaceName: org.name,
      domain,
      trialTier: SELF_SERVE_TRIAL_TIER,
      trialEndsAt: org.trialEndsAt?.toISOString() ?? null
    });
    await recordSignupStage("CREATED", { email, organizationId: org.id });
    await notifySignupOutcome({
      kind: "created",
      organizationId: org.id,
      workspaceName: org.name,
      slug,
      ownerEmail: email,
      workspaceUrl: workspaceUrlForSlug(slug),
      trialEndsAt: org.trialEndsAt,
      trialTier: SELF_SERVE_TRIAL_TIER
    });

    res.status(201).json({
      slug,
      url: workspaceUrlForSlug(slug),
      trialEndsAt: org.trialEndsAt,
      trialDays: TRIAL_DAYS
    });
  }
);

/* ------------------------------------------------------------------ *
 * Step 3b — ask to join the company's workspace
 * ------------------------------------------------------------------ */

/** Join requests land in Task 8 of docs/SIGNUP_PHASE1_BUILD_PLAN.md; until then the route says so
 *  rather than pretending, so a page built against the contract fails loudly instead of quietly. */
signupRouter.post("/join", (_req, res) => {
  res.status(501).json({ message: "Asking to join an existing workspace is not available yet." });
});
