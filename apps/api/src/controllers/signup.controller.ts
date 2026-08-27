/**
 * Self-serve signup — the route behind "Start free trial", which until now went to `/login`, where
 * there is no way to create a workspace.
 *
 * THIS IS THE ONLY PUBLIC ROUTE IN THE PRODUCT THAT CREATES INFRASTRUCTURE. Everything else an
 * anonymous caller can reach reads, or writes a row. This one creates a MySQL database, runs every
 * migration against it, and seeds it — so the guards here are doing more work than the ones on any
 * other public endpoint, and each is worth naming:
 *
 *  - VERIFY-FIRST. Nothing is provisioned until a code sent to the address comes back, reusing the
 *    same machinery workspace discovery uses. Without it, one POST creates a database, and a script
 *    creates a thousand.
 *  - NO FREE-MAIL DOMAINS. A trial is per organisation; gmail.com is not one, and allowing it turns
 *    "one trial per company" into "one trial per address anybody can make in ten seconds".
 *  - SLUG COLLISIONS ARE A 409, NEVER A SILENT SUFFIX. `acme-2` handed to somebody who asked for
 *    `acme` is a URL they will not remember and a workspace their colleagues will not find.
 *  - MOUNTED WITHOUT TENANT RESOLUTION. There is no tenant yet — that is the point — so this router
 *    is registered before `resolveTenant`, like the webhook receivers.
 *
 * WHAT IT DOES NOT DO: take payment. The trial is real and free; the card is asked for at the end,
 * from inside the workspace, by the same billing flow an upgrade already uses.
 */
import { Router } from "express";
import { z } from "zod";
import { controlPrisma } from "../config/control-prisma.js";
import { withOrgTenant } from "../config/with-org-tenant.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { templates } from "../services/mail-templates.js";
import { dispatchTransactional } from "../services/notify.service.js";
import { sendPlatformMail } from "../services/platform-mail.service.js";
import { provisionOrganization } from "../services/provisioning.service.js";
import {
  checkVerificationCode,
  issueVerificationCode,
  rememberWorkspaceMembership,
  workspaceUrlForSlug
} from "../services/workspace-directory.service.js";

export const signupRouter = Router();

/** How long a self-serve trial runs. Fifteen days, not fourteen: it survives two weekends plus the
 *  Monday somebody actually gets to it. */
const TRIAL_DAYS = 15;

/**
 * Addresses that are a person rather than an organisation.
 *
 * Deliberately short and not exhaustive — a complete list of free-mail providers does not exist and
 * chasing one is how this becomes a maintenance burden that still misses the newest domain. It
 * catches the overwhelming majority of casual abuse, and the verify-first step catches the rest by
 * costing an inbox per attempt.
 */
const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "hotmail.com", "hotmail.co.uk",
  "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mail.com",
  "gmx.com", "gmx.net", "yandex.com", "proton.me", "protonmail.com", "zoho.com", "tutanota.com"
]);

/** Slugs that must never become a workspace: they would shadow a real hostname on the deployment. */
const RESERVED_SLUGS = new Set(["www", "app", "api", "admin", "platform-admin", "mail", "smtp", "status", "docs", "help", "support", "static", "cdn", "assets"]);

function slugProblem(slug: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(slug)) {
    return "Use 3–63 characters: lowercase letters, numbers and hyphens, starting and ending with a letter or number.";
  }
  if (RESERVED_SLUGS.has(slug)) return "That address is reserved. Try another.";
  return null;
}

/* ------------------------------------------------------------------ *
 * Step 1 — prove the address
 * ------------------------------------------------------------------ */

signupRouter.post(
  "/start",
  validate(z.object({ body: z.object({ email: z.string().email().max(255) }) })),
  async (req, res) => {
    const email = req.body.email.trim().toLowerCase();
    const domain = email.split("@")[1] ?? "";
    if (FREE_MAIL_DOMAINS.has(domain)) {
      // Named plainly rather than hidden behind a generic error: this one IS worth telling the
      // person, because it is a mistake they can fix in five seconds, not an enumeration signal.
      throw new AppError(422, "Use your work email address — a workspace belongs to a company, not to a personal inbox.");
    }

    const { token, code } = issueVerificationCode(email);
    // `sendPlatformMail`, NOT `dispatchTransactional`. There is no workspace yet — that is what
    // this route is for — and the normal path resolves an SMTP transport per tenant and writes an
    // EmailLog row through the tenant-scoped Prisma proxy. Using it here threw "No tenant context
    // is active" on the very first live request, which is the same trap `send-test-email.ts` fell
    // into. See platform-mail.service.ts for what this gives up in exchange.
    await sendPlatformMail({
      to: email,
      subject: "Your TimeSphere verification code",
      html: templates.workspaceFind(code)
    });

    res.status(202).json({ token, message: "Check your email for a 6-digit code." });
  }
);

/* ------------------------------------------------------------------ *
 * Step 2 — create the workspace
 * ------------------------------------------------------------------ */

signupRouter.post(
  "/complete",
  validate(
    z.object({
      body: z.object({
        token: z.string().min(1).max(200),
        code: z.string().min(4).max(12),
        workspaceName: z.string().min(2).max(200),
        slug: z.string().min(3).max(63),
        adminName: z.string().min(2).max(120),
        adminPassword: z.string().min(8).max(200)
      })
    })
  ),
  async (req, res) => {
    const check = checkVerificationCode(req.body.token, req.body.code);
    if (!check.ok) throw new AppError(400, "That code isn't right, or it has expired. Request a new one.");

    const slug = req.body.slug.trim().toLowerCase();
    const problem = slugProblem(slug);
    if (problem) throw new AppError(422, problem);

    const taken = await controlPrisma.organization.findUnique({ where: { slug }, select: { id: true } });
    if (taken) throw new AppError(409, "That workspace address is already taken. Try another.");

    const now = new Date();
    const org = await controlPrisma.organization.create({
      data: {
        name: req.body.workspaceName.trim(),
        slug,
        status: "PROVISIONING",
        // planTier stays STARTER — what they have PAID for. The trial grants Team on top of it, and
        // keeping the two apart is what lets the trial expire without guessing what to fall back to.
        planTier: "STARTER",
        trialTier: "TEAM",
        trialStartedAt: now,
        trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000)
      }
    });

    try {
      // Synchronous, and it takes a while — it creates a database and runs every migration. Done
      // inline anyway because the alternative is handing back a workspace URL that 503s for the
      // next thirty seconds, which reads as a broken signup on the one page where first impressions
      // are the entire product.
      await provisionOrganization(org.id, {
        adminEmail: check.email,
        adminName: req.body.adminName.trim(),
        adminPassword: req.body.adminPassword
      });
    } catch (error) {
      // A half-provisioned org would sit in PROVISIONING forever, holding its slug hostage and
      // answering 503 to anybody who tried it. Removing the registration is the honest cleanup;
      // the physical database, if it got that far, is left for an operator, because deleting a
      // database automatically in an error path is how the wrong one gets dropped.
      await controlPrisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
      throw new AppError(502, `Couldn't finish setting up your workspace: ${(error as Error).message}`);
    }

    // So the finder can route them here next time without waiting for a first sign-in.
    await rememberWorkspaceMembership(org.id, check.email);

    await withOrgTenant(slug, async () => {
      await dispatchTransactional({
        to: check.email,
        templateKey: "welcome",
        vars: { name: req.body.adminName.trim(), appUrl: workspaceUrlForSlug(slug) },
        fallback: { subject: "Welcome to TimeSphere", html: templates.welcome(req.body.adminName.trim()) }
      });
    });

    res.status(201).json({
      slug,
      url: workspaceUrlForSlug(slug),
      trialEndsAt: org.trialEndsAt,
      trialDays: TRIAL_DAYS
    });
  }
);
