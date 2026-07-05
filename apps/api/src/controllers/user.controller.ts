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
        managerId: z.string().uuid().optional().nullable()
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

const patchSchema = z.object({
  body: z.object({
    name: z.string().min(2).optional(),
    email: z.string().email().optional(),
    status: z.enum(["ACTIVE", "INACTIVE", "PENDING_VERIFICATION"]).optional(),
    role: z.string().optional(),
    managerId: z.string().uuid().nullable().optional()
  })
});

userRouter.patch("/:id", validate(patchSchema), async (req, res) => {
  const data: {
    name?: string;
    email?: string;
    status?: "ACTIVE" | "INACTIVE" | "PENDING_VERIFICATION";
    roleId?: string;
    managerId?: string | null;
  } = {};
  if (req.body.name) data.name = req.body.name;
  if (req.body.email) data.email = req.body.email;
  if (req.body.status) data.status = req.body.status;
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
  const user = await prisma.user.update({ where: { id: String(req.params.id) }, data, include: { role: true } });
  await audit(req.user!.id, "user.updated", "User", user.id, req.body);
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
