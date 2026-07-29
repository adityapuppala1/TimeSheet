/**
 * WHAT: admin-only user management — create/update/deactivate, role assignment, manager-chain
 * assignment, password reset, and (re)sending the welcome email.
 * WHY: user creation is the one place seat-limit enforcement (`plan-limits.service.ts`) has to
 * run synchronously before the row is inserted — an org at its plan tier's seat cap can't
 * create another ACTIVE user, checked fresh on every call so a platform admin lowering the
 * limit takes effect on the very next attempt.
 * WHO calls this: `apps/web/src/pages/AdminPages.tsx` (UsersPage).
 */
import { Router } from "express";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { dispatchTransactional } from "../services/notify.service.js";
import { templates } from "../services/mail-templates.js";
import { findCoveredUnenrolledUserIds, notifyEnrollmentRequired } from "../services/face.service.js";
import { getEffectiveSeatLimit } from "../services/plan-limits.service.js";
import { hashPassword } from "../utils/security.js";

export const userRouter = Router();
userRouter.use(requireAuth, requirePermission(permissions.USERS_MANAGE));

async function sendWelcomeEmail(user: { id: string; name: string; email: string }) {
  const result = await dispatchTransactional({
    to: user.email,
    templateKey: "welcome",
    vars: { name: user.name, appUrl: env.APP_BASE_URL },
    fallback: { subject: "Welcome to TimeSphere", html: templates.welcome(user.name) }
  });
  if (result.ok) {
    console.info(`[user.welcome] sent to ${user.email} (emailLogId=${result.emailLogId})`);
  } else {
    console.warn(`[user.welcome] NOT sent to ${user.email}: ${result.errorMessage}`);
  }
  return result;
}

userRouter.get("/roles", async (_req, res) => {
  const roles = await prisma.role.findMany({ orderBy: { name: "asc" } });
  res.json(roles);
});

userRouter.get("/", async (req, res) => {
  const search = String(req.query.search ?? "");
  const users = await prisma.user.findMany({
    where: {
      deletedAt: null,
      OR: search ? [{ name: { contains: search } }, { email: { contains: search } }] : undefined
    },
    include: {
      role: true,
      projectAssignments: { include: { project: true } },
      manager: { select: { id: true, name: true, email: true } }
    },
    orderBy: { createdAt: "desc" },
    take: 50
  });
  res.json(users.map(({ passwordHash: _passwordHash, ...user }) => user));
});

userRouter.post(
  "/",
  validate(
    z.object({
      body: z.object({
        name: z.string().min(2),
        email: z.string().email(),
        role: z.string(),
        password: z.string().min(8),
        managerId: z.string().uuid().optional().nullable(),
        designation: z.string().max(120).optional().nullable(),
        faceVerificationRequired: z.boolean().optional(),
        githubUsername: z.string().max(120).optional().nullable()
      })
    })
  ),
  async (req, res) => {
    // Plan-tier seat enforcement — re-checked on every creation (not cached) so a platform
    // admin lowering a tier's seat limit, or an org outgrowing its plan, takes effect
    // immediately rather than after some reconciliation job. Counts the same population
    // platform-admin-analytics.service.ts reports as "seats" (ACTIVE, not soft-deleted), so
    // the number an org sees in the console and the number enforced here always agree.
    const { orgId } = requireTenantContext();
    const [seatLimit, activeSeats] = await Promise.all([
      getEffectiveSeatLimit(orgId),
      prisma.user.count({ where: { status: "ACTIVE", deletedAt: null } })
    ]);
    if (activeSeats >= seatLimit) {
      throw new AppError(402, `Seat limit reached (${seatLimit} seats on the current plan). Contact your platform administrator to add more seats.`);
    }

    const role = await prisma.role.findUniqueOrThrow({ where: { name: req.body.role } });
    if (req.body.managerId) {
      const manager = await prisma.user.findUnique({ where: { id: req.body.managerId } });
      if (!manager) throw new AppError(422, "Manager not found");
    }
    const user = await prisma.user.create({
      data: {
        name: req.body.name,
        email: req.body.email,
        roleId: role.id,
        status: "ACTIVE",
        passwordHash: await hashPassword(req.body.password),
        managerId: req.body.managerId ?? undefined,
        designation: req.body.designation ?? undefined,
        faceVerificationRequired: req.body.faceVerificationRequired ?? undefined,
        githubUsername: req.body.githubUsername ?? undefined,
        notificationPreference: { create: {} }
      }
    });
    await audit(req.user!.id, "user.created", "User", user.id);

    const welcomeResult = await sendWelcomeEmail(user);
    await audit(
      req.user!.id,
      welcomeResult.ok ? "user.welcome_sent" : "user.welcome_failed",
      "User",
      user.id,
      welcomeResult.errorMessage ? { error: welcomeResult.errorMessage } : undefined
    );

    res.status(201).json({
      ...user,
      welcomeEmail: {
        sent: welcomeResult.ok,
        status: welcomeResult.status,
        errorMessage: welcomeResult.errorMessage ?? null,
        emailLogId: welcomeResult.emailLogId ?? null
      }
    });
  }
);

const bulkRowSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  role: z.string().min(1),
  password: z.string().min(8).optional(),
  managerEmail: z.string().email().optional().or(z.literal("")),
  designation: z.string().max(120).optional().or(z.literal("")),
  githubUsername: z.string().max(120).optional().or(z.literal(""))
});

const bulkUsersSchema = z.object({
  body: z.object({ rows: z.array(bulkRowSchema).min(1).max(500) })
});

/**
 * Bulk user import — same shape every bulk-import feature in this app follows (see the CSV
 * template's own header comment for the exact columns): parse client-side (the frontend uses
 * papaparse so malformed CSV never reaches here), POST the already-parsed rows, get back one
 * result per row so a partial failure (one bad email, one duplicate) doesn't block the rest.
 *
 * WHY two passes instead of one: `managerEmail` can reference someone else *in the same file*
 * (a manager and their reports uploaded together) — resolving managers only after every row's
 * user has been created means upload order within the CSV never matters.
 */
userRouter.post("/bulk", validate(bulkUsersSchema), async (req, res) => {
  const rows = req.body.rows as Array<{
    name: string;
    email: string;
    role: string;
    password?: string;
    managerEmail?: string;
    designation?: string;
    githubUsername?: string;
  }>;

  const { orgId } = requireTenantContext();
  const [seatLimit, activeSeats, roles] = await Promise.all([
    getEffectiveSeatLimit(orgId),
    prisma.user.count({ where: { status: "ACTIVE", deletedAt: null } }),
    prisma.role.findMany()
  ]);
  const roleByName = new Map<string, (typeof roles)[number]>(roles.map((r) => [r.name, r]));

  if (activeSeats + rows.length > seatLimit) {
    throw new AppError(
      402,
      `This upload would create ${rows.length} users, exceeding the seat limit (${seatLimit} seats, ${activeSeats} already used). Reduce the file or contact your platform administrator.`
    );
  }

  const results: Array<{ row: number; email: string; success: boolean; error?: string; userId?: string }> = [];
  const emailToId = new Map<string, string>();

  // Pass 1 — create every valid row without a manager link yet.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const role = roleByName.get(row.role);
      if (!role) throw new Error(`Unknown role "${row.role}"`);
      const existing = await prisma.user.findUnique({ where: { email: row.email } });
      if (existing) throw new Error("A user with this email already exists");

      const user = await prisma.user.create({
        data: {
          name: row.name,
          email: row.email,
          roleId: role.id,
          status: "ACTIVE",
          passwordHash: await hashPassword(row.password && row.password.length >= 8 ? row.password : `Bulk-${Math.random().toString(36).slice(2)}!A1`),
          designation: row.designation || undefined,
          githubUsername: row.githubUsername || undefined,
          notificationPreference: { create: {} }
        }
      });
      emailToId.set(row.email.toLowerCase(), user.id);
      results.push({ row: i, email: row.email, success: true, userId: user.id });
    } catch (error) {
      results.push({ row: i, email: row.email, success: false, error: (error as Error).message });
    }
  }

  // Pass 2 — resolve managerEmail for every successfully-created row, against both this batch
  // and pre-existing users, then link and (best-effort, never blocks the response) send the
  // welcome email — same sendWelcomeEmail() the single-create route uses.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const result = results[i];
    if (!result.success || !row.managerEmail) continue;
    try {
      const managerId = emailToId.get(row.managerEmail.toLowerCase()) ?? (await prisma.user.findUnique({ where: { email: row.managerEmail } }))?.id;
      if (!managerId) throw new Error(`Manager "${row.managerEmail}" not found (create them first, or fix the email)`);
      await prisma.user.update({ where: { id: result.userId! }, data: { managerId } });
    } catch (error) {
      result.error = `User created, but manager link failed: ${(error as Error).message}`;
    }
  }

  const createdUsers = results.filter((r) => r.success).map((r) => ({ id: r.userId!, name: rows[r.row].name, email: r.email }));
  for (const user of createdUsers) {
    sendWelcomeEmail(user).catch(() => undefined);
  }

  await audit(req.user!.id, "user.bulk_imported", "User", undefined, {
    total: rows.length,
    created: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length
  });

  res.status(201).json({ results });
});

const patchSchema = z.object({
  body: z.object({
    name: z.string().min(2).optional(),
    email: z.string().email().optional(),
    status: z.enum(["ACTIVE", "INACTIVE", "PENDING_VERIFICATION"]).optional(),
    role: z.string().optional(),
    managerId: z.string().uuid().nullable().optional(),
    designation: z.string().max(120).nullable().optional(),
    faceVerificationRequired: z.boolean().optional(),
    githubUsername: z.string().max(120).nullable().optional()
  })
});

userRouter.patch("/:id", validate(patchSchema), async (req, res) => {
  const data: {
    name?: string;
    email?: string;
    status?: "ACTIVE" | "INACTIVE" | "PENDING_VERIFICATION";
    roleId?: string;
    managerId?: string | null;
    designation?: string | null;
    faceVerificationRequired?: boolean;
    githubUsername?: string | null;
  } = {};
  if (req.body.name) data.name = req.body.name;
  if (req.body.email) data.email = req.body.email;
  if (req.body.status) data.status = req.body.status;
  if ("designation" in req.body) data.designation = req.body.designation ?? null;
  if ("faceVerificationRequired" in req.body) data.faceVerificationRequired = Boolean(req.body.faceVerificationRequired);
  if ("githubUsername" in req.body) data.githubUsername = req.body.githubUsername ?? null;
  if (req.body.role) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: req.body.role } });
    data.roleId = role.id;
  }
  if ("managerId" in req.body) {
    if (req.body.managerId && req.body.managerId === String(req.params.id)) {
      throw new AppError(422, "A user cannot be their own manager");
    }
    data.managerId = req.body.managerId ?? null;
  }

  // Capture the before-state of the face flag so the enrollment prompt only fires on the
  // false→true transition — not on every unrelated PATCH that happens to echo the field back.
  const previous =
    data.faceVerificationRequired === true
      ? await prisma.user.findUnique({ where: { id: String(req.params.id) }, select: { faceVerificationRequired: true } })
      : null;

  const user = await prisma.user.update({ where: { id: String(req.params.id) }, data, include: { role: true } });
  await audit(req.user!.id, "user.updated", "User", user.id, req.body);

  // The person just became individually covered by the face policy — tell them now, not at
  // their next blocked submission. notifyEnrollmentRequired no-ops unless the policy is live
  // (feature enabled + an action requires it + plan entitlement) and they're unenrolled.
  if (previous && !previous.faceVerificationRequired) {
    findCoveredUnenrolledUserIds()
      .then((ids) => (ids.includes(user.id) ? notifyEnrollmentRequired([user.id]) : 0))
      .catch(() => undefined);
  }

  res.json(user);
});

userRouter.delete("/:id", async (req, res) => {
  await prisma.user.update({ where: { id: String(req.params.id) }, data: { deletedAt: new Date(), status: "INACTIVE" } });
  await audit(req.user!.id, "user.deleted", "User", String(req.params.id));
  res.status(204).send();
});

userRouter.post("/:id/reset-password", async (req, res) => {
  const password = req.body.password || "Admin@12345";
  await prisma.user.update({ where: { id: String(req.params.id) }, data: { passwordHash: await hashPassword(password) } });
  await audit(req.user!.id, "user.password_reset", "User", String(req.params.id));
  res.json({ message: "Password reset successfully" });
});

/**
 * Resend the welcome email to a user (super-admin / users-manage).
 * Returns 502 with the underlying SMTP error if delivery still fails,
 * so the operator sees the actual cause instead of a fake success toast.
 */
userRouter.post("/:id/resend-welcome", async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: String(req.params.id) },
    select: { id: true, name: true, email: true, status: true, deletedAt: true }
  });
  if (!user || user.deletedAt) throw new AppError(404, "User not found");
  if (user.status !== "ACTIVE") throw new AppError(422, "User is not active");

  const result = await sendWelcomeEmail(user);
  await audit(
    req.user!.id,
    result.ok ? "user.welcome_resent" : "user.welcome_failed",
    "User",
    user.id,
    result.errorMessage ? { error: result.errorMessage } : undefined
  );

  if (!result.ok) {
    throw new AppError(502, `Welcome email NOT delivered: ${result.errorMessage ?? "SMTP refused the message"}`);
  }
  res.json({ sent: true, to: user.email, emailLogId: result.emailLogId });
});
