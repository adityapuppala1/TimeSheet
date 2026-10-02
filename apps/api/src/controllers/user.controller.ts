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
import { permissions, resolveHeldRoles, roles, type RoleName } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { dispatchTransactional } from "../services/notify.service.js";
import { templates } from "../services/mail-templates.js";
import { csvCell, CSV_EOL, UTF8_BOM } from "../utils/csv.js";
import { findCoveredUnenrolledUserIds, notifyEnrollmentRequired } from "../services/face.service.js";
import { getOnlineSeenByUser } from "../services/maintenance.service.js";
import { assertSeatAvailable, syncSeatsAfterChange, takesASeat } from "../services/seats.service.js";
import { generateTempPassword, hashPassword } from "../utils/security.js";
import { tenantBaseUrl } from "../services/workspace-directory.service.js";
import {
  actOnRefusal,
  assertMayActOn,
  assertMayGrant,
  assertNotLastSuperAdmin,
  assertNotSelfLockout,
  AUTHORITY_TARGET_SELECT,
  grantRefusal,
  loadAuthorityTarget,
  toAuthorityTarget,
  type AuthorityTarget
} from "../services/user-authority.service.js";

export const userRouter = Router();
userRouter.use(requireAuth, requirePermission(permissions.USERS_MANAGE));

/** A real ceiling rather than a page size: past this the answer is a filtered export, not a bigger
 *  file. The response says whether it truncated, in a header a script can read. */
const USER_EXPORT_ROW_CAP = 10_000;

async function sendWelcomeEmail(user: { id: string; name: string; email: string }) {
  const result = await dispatchTransactional({
    to: user.email,
    templateKey: "welcome",
    vars: { name: user.name, appUrl: tenantBaseUrl() },
    fallback: { subject: "Welcome to TimeSphere", html: templates.welcome(user.name) }
  });
  if (result.ok) {
    console.info(`[user.welcome] sent to ${user.email} (emailLogId=${result.emailLogId})`);
  } else {
    console.warn(`[user.welcome] NOT sent to ${user.email}: ${result.errorMessage}`);
  }
  return result;
}

/**
 * Writes a user's held-role set to exactly `roleNames` — a full replace, not an incremental add.
 * Deliberately not additive: the plain single-`role` field (available to ADMIN too) means "this
 * account now has exactly one role", matching its exact pre-multi-role behavior; only the
 * SUPER_ADMIN-only `roles` array can produce more than one held role. Run after the `roleId`
 * write so the caller's transaction (if any) covers both.
 */
async function replaceHeldRoles(userId: string, roleNames: RoleName[]) {
  const roleRows = await prisma.role.findMany({ where: { name: { in: roleNames } }, select: { id: true } });
  await prisma.userRole.deleteMany({ where: { userId } });
  await prisma.userRole.createMany({ data: roleRows.map((r) => ({ userId, roleId: r.id })) });
}

userRouter.get("/roles", async (_req, res) => {
  const roles = await prisma.role.findMany({ orderBy: { name: "asc" } });
  res.json(roles);
});

userRouter.get("/", async (req, res) => {
  const search = String(req.query.search ?? "");
  const [users, onlineSeen] = await Promise.all([
    prisma.user.findMany({
      where: {
        deletedAt: null,
        OR: search ? [{ name: { contains: search } }, { email: { contains: search } }] : undefined
      },
      include: {
        role: true,
        projectAssignments: { include: { project: true } },
        manager: { select: { id: true, name: true, email: true } }
      },
      orderBy: { name: "asc" },
      // This route feeds PICKERS — assignee, manager, approver dropdowns. It was capped at 50,
      // which meant that in any org with more than fifty people those dropdowns silently omitted
      // most of them, ordered by signup date, with nothing on screen to say so. A picker that
      // cannot offer the person you need is worse than a slow one.
      //
      // The management table no longer uses this route at all (see GET /users/paged), so the cap
      // only ever has to cover "everyone who could appear in a dropdown". 2000 is a real ceiling
      // rather than an arbitrary page size; an org past it needs a searchable picker, which is a
      // different design and not something to fake with a bigger number.
      take: 2000
    }),
    // Live presence, same 15-min lastSeenAt definition as the Maintenance panel — one sessions
    // query for the whole page, not one per row.
    getOnlineSeenByUser()
  ]);
  res.json(
    users.map(({ passwordHash: _passwordHash, ...user }) => ({
      ...user,
      online: onlineSeen.has(user.id),
      lastSeenAt: onlineSeen.get(user.id) ?? null
    }))
  );
});


/**
 * GET /users/export.csv — the people table, as a file.
 *
 * IT TAKES THE SAME QUERY THE TABLE DOES, through the same `whereFromQuery`. "Download the current
 * list" has to mean the list actually on screen: an export that quietly ignored the filters would
 * hand somebody a different answer to the question they thought they were asking, and they would
 * not find out until they acted on it.
 *
 * `online` is applied here rather than in SQL for the same reason the paged route does it — it is
 * derived from live sessions, not a column.
 */
userRouter.get("/export.csv", async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const where = whereFromQuery(q);

  const [rows, onlineSeen] = await Promise.all([
    prisma.user.findMany({
      where,
      include: {
        role: true,
        manager: { select: { name: true, email: true } },
        userRoles: { select: { role: { select: { name: true } } } }
      },
      orderBy: { name: "asc" },
      take: USER_EXPORT_ROW_CAP
    }),
    getOnlineSeenByUser()
  ]);

  let people = rows;
  if (q.online === "online") people = people.filter((u) => onlineSeen.has(u.id));
  if (q.online === "offline") people = people.filter((u) => !onlineSeen.has(u.id));

  const header = [
    "Name",
    "Email",
    "Role",
    "Also grants",
    "Job title",
    "Manager",
    "Manager email",
    "Status",
    "Online",
    "First login",
    "Last login",
    "Face verification"
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const u of people) {
    const held = resolveHeldRoles(u.role.name as RoleName, u.userRoles.map((ur) => ur.role.name as RoleName))
      .filter((r) => r !== u.role.name)
      .join(" / ");
    lines.push(
      [
        u.name,
        u.email,
        u.role.name,
        held,
        u.designation ?? "",
        u.manager?.name ?? "",
        u.manager?.email ?? "",
        u.status,
        onlineSeen.has(u.id) ? "Online" : "Offline",
        u.firstLoginAt ? u.firstLoginAt.toISOString() : "",
        u.lastLoginAt ? u.lastLoginAt.toISOString() : "",
        u.faceVerificationRequired ? "Required" : "Workspace default"
      ]
        .map(csvCell)
        .join(",")
    );
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="users-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader("X-Export-Rows-Included", String(people.length));
  res.setHeader("X-Export-Truncated", rows.length >= USER_EXPORT_ROW_CAP ? "true" : "false");
  res.setHeader("Access-Control-Expose-Headers", "X-Export-Rows-Included, X-Export-Truncated, Content-Disposition");
  await audit(req.user!.id, "user.exported", "User", req.user!.id, { rows: people.length });
  res.send(UTF8_BOM + lines.join(CSV_EOL) + CSV_EOL);
});

/**
 * GET /users/paged — the user-management table: filters, search, sort, pagination and the facet
 * values the filter dropdowns need.
 *
 * WHY A SECOND ENDPOINT RATHER THAN CHANGING `GET /users`: six callers use the flat array from
 * that route to populate assignee and manager pickers. Wrapping it in a pagination envelope would
 * break every one of them for no benefit — a picker wants "everyone I could choose", a management
 * table wants "page 3 of the inactive contractors". They are different questions and they now have
 * different endpoints, rather than one endpoint with a mode flag that each caller has to
 * understand.
 *
 * FILTERING BY ONLINE STATUS IS DONE IN MEMORY, deliberately. Presence lives in the Session table
 * under a 15-minute lastSeenAt rule, not on User, so "online" cannot be a WHERE clause without a
 * join that would make every other filter slower for the one filter that is used least. The page
 * is capped at 200 rows, so the in-memory pass is bounded. The cost is that `total` reflects the
 * database filters and the online filter narrows the page — which is why the response reports
 * both numbers instead of pretending one covers everything.
 */
const pagedQuerySchema = z.object({
  query: z.object({
    search: z.string().max(120).optional(),
    roleId: z.string().optional(),
    designation: z.string().max(120).optional(),
    status: z.enum(["ACTIVE", "INACTIVE", "PENDING_VERIFICATION"]).optional(),
    online: z.enum(["online", "offline"]).optional(),
    sort: z.enum(["name", "email", "createdAt", "lastSeenAt", "role"]).default("name"),
    dir: z.enum(["asc", "desc"]).default("asc"),
    page: z.coerce.number().int().min(1).default(1),
    // The ceiling is what protects the server; a floor of 5 was arbitrary and only served to
    // reject legitimate small pages.
    pageSize: z.coerce.number().int().min(1).max(200).default(25)
  })
});

/** Shared by the table and by bulk-by-filter, so "apply to everything matching" can never select
 *  a different set from the one the operator was looking at. Duplicating this is how those two
 *  drift apart, and the failure mode is deleting the wrong people. */
function whereFromQuery(q: Record<string, unknown>) {
  const search = String(q.search ?? "").trim();
  const needle = search.toUpperCase().replace(/\s+/g, "_");
  const matchedRoles = search ? roles.filter((r) => r.includes(needle)) : [];
  return {
    deletedAt: null,
    ...(q.roleId ? { roleId: String(q.roleId) } : {}),
    ...(q.status ? { status: q.status as "ACTIVE" | "INACTIVE" | "PENDING_VERIFICATION" } : {}),
    ...(q.designation ? { designation: String(q.designation) } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search } },
            { email: { contains: search } },
            { designation: { contains: search } },
            // Searching by role name was asked for explicitly — people think in "find the
            // managers", not "filter by the role dropdown". `Role.name` is an enum, so there is
            // no `contains` to reach for: the match is done against the known values and turned
            // into an `in`. An empty match list would select every role, so it is omitted instead.
            ...(matchedRoles.length ? [{ role: { is: { name: { in: matchedRoles } } } }] : [])
          ]
        }
      : {})
  };
}

userRouter.get("/paged", validate(pagedQuerySchema), async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const page = Number(q.page ?? 1);
  const pageSize = Number(q.pageSize ?? 25);
  const sort = String(q.sort ?? "name");
  const dir = (String(q.dir ?? "asc") === "desc" ? "desc" : "asc") as "asc" | "desc";
  const where = whereFromQuery(q);

  const orderBy =
    sort === "role" ? { role: { name: dir } } : sort === "lastSeenAt" ? { createdAt: dir } : { [sort]: dir };

  const [total, rows, onlineSeen, designations] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      include: {
        role: true,
        manager: { select: { id: true, name: true, email: true } },
        _count: { select: { projectAssignments: true } },
        userRoles: { select: { role: { select: { name: true } } } }
      },
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize
    }),
    getOnlineSeenByUser(),
    // Facet values for the designation dropdown. Distinct over live users only — offering a
    // filter that matches nobody is worse than not offering it.
    prisma.user.findMany({
      where: { deletedAt: null, designation: { not: null } },
      select: { designation: true },
      distinct: ["designation"],
      orderBy: { designation: "asc" }
    })
  ]);

  let items = rows.map(({ passwordHash: _passwordHash, userRoles, ...user }) => ({
    ...user,
    online: onlineSeen.has(user.id),
    lastSeenAt: onlineSeen.get(user.id) ?? null,
    heldRoles: resolveHeldRoles(user.role.name as RoleName, userRoles.map((ur) => ur.role.name as RoleName))
  }));
  if (q.online === "online") items = items.filter((u) => u.online);
  if (q.online === "offline") items = items.filter((u) => !u.online);

  res.json({
    items,
    total,
    page,
    pageSize,
    /** Present so the UI can say "showing 12 of 25 on this page" when the online filter is on,
     *  rather than silently showing fewer rows than the page size implies. */
    filteredOnPage: items.length,
    onlineFilterApplied: Boolean(q.online),
    designations: designations.map((d) => d.designation).filter((d): d is string => Boolean(d))
  });
});

/**
 * POST /users/bulk-action — one action across many users.
 *
 * TWO WAYS TO CHOOSE THE TARGETS, and the second is the important one: an explicit list of ids,
 * or the CURRENT FILTER. "Select everything matching" cannot be done by sending ten thousand ids
 * from a browser, and re-deriving the set on the server from the same `whereFromQuery` the table
 * used is the only way the operator's selection and the server's selection cannot disagree.
 *
 * REFUSALS ARE PER-USER, NOT PER-REQUEST. A bulk action that aborts on the first protected user
 * leaves the operator with a partially-applied change and no idea which half ran. Each target is
 * evaluated on its own and the response says exactly who was skipped and why.
 */
const bulkActionSchema = z.object({
  body: z
    .object({
      action: z.enum(["DEACTIVATE", "ACTIVATE", "RESET_PASSWORD", "RESEND_WELCOME", "FORCE_LOGOUT", "DELETE"]),
      userIds: z.array(z.string()).max(1000).optional(),
      /** Mirrors the table's query. Ignored when `userIds` is given. */
      filter: z
        .object({
          search: z.string().max(120).optional(),
          roleId: z.string().optional(),
          designation: z.string().max(120).optional(),
          status: z.enum(["ACTIVE", "INACTIVE", "PENDING_VERIFICATION"]).optional()
        })
        .optional(),
      /** Only for RESET_PASSWORD. */
      password: z.string().min(8).max(200).optional()
    })
    .refine((b) => (b.userIds && b.userIds.length > 0) || b.filter, {
      message: "Choose some users, or a filter to apply this to."
    })
});

type BulkAction = "DEACTIVATE" | "ACTIVATE" | "RESET_PASSWORD" | "RESEND_WELCOME" | "FORCE_LOGOUT" | "DELETE";

/** The bulk actions that change how many seats are in use — and so what Stripe should bill. */
const SEAT_CHANGING_ACTIONS = new Set<BulkAction>(["ACTIVATE", "DEACTIVATE", "DELETE"]);

/**
 * Why bulk skips this target without trying, or null. The single-user routes' guards, from the same
 * module (services/user-authority.service.ts), so bulk cannot drift from them — the whole reason bulk
 * does not just call the database with an `in` clause. "Super admin" includes someone holding it
 * through a UserRole grant while switched into another role: they can switch back at will.
 */
function bulkSkipReason(actor: { id: string; role: string }, target: Parameters<typeof toAuthorityTarget>[0], action: BulkAction): string | null {
  const refusal = actOnRefusal(actor, toAuthorityTarget(target));
  if (refusal) return refusal;
  // Locking yourself out mid-bulk is unrecoverable without another admin, so it is refused rather
  // than confirmed — there is no version of this the operator meant.
  if (target.id === actor.id && action !== "RESEND_WELCOME") return "You can't apply this to your own account";
  return null;
}

userRouter.post("/bulk-action", validate(bulkActionSchema), async (req, res) => {
  const { action, userIds, filter, password } = req.body as {
    action: BulkAction;
    userIds?: string[];
    filter?: Record<string, unknown>;
    password?: string;
  };

  const targets = await prisma.user.findMany({
    where: userIds?.length ? { id: { in: userIds }, deletedAt: null } : whereFromQuery(filter ?? {}),
    select: { ...AUTHORITY_TARGET_SELECT, name: true, email: true, isAgent: true }
  });

  // The seat limit is a limit on the BATCH, unlike every other refusal here: activating "as many as
  // fit" would choose who comes back by database order. So an over-limit batch is refused whole and
  // up front — the rule the CSV import already follows. Only people who would actually take a seat
  // count: the already-active, agent identities, and anyone skipped below do not.
  if (action === "ACTIVATE") {
    await assertSeatAvailable(targets.filter((t) => !bulkSkipReason(req.user!, t, action) && takesASeat(t, "ACTIVE")).length);
  }

  const done: string[] = [];
  const skipped: Array<{ id: string; name: string; reason: string }> = [];
  /** Filled only by RESET_PASSWORD with no explicit password: each person gets their OWN random
   *  one-time password, returned once in this response and stored nowhere in plaintext — the
   *  operator copies them out now or resets again. Never written to the audit log. */
  const generatedPasswords: Array<{ id: string; name: string; email: string; password: string }> = [];

  for (const target of targets) {
    const skipReason = bulkSkipReason(req.user!, target, action);
    if (skipReason) {
      skipped.push({ id: target.id, name: target.name, reason: skipReason });
      continue;
    }

    try {
      // Throws (and so lands in `skipped` below, named) when this would leave no active super admin.
      if (action === "DEACTIVATE" || action === "DELETE") {
        await assertNotLastSuperAdmin(toAuthorityTarget(target), { status: "INACTIVE", deleted: action === "DELETE" });
      }
      switch (action) {
        case "DEACTIVATE":
        case "ACTIVATE": {
          await prisma.user.update({
            where: { id: target.id },
            data: { status: action === "ACTIVATE" ? "ACTIVE" : "INACTIVE" }
          });
          // Deactivating without ending sessions leaves the person working until their token
          // expires, which is not what "deactivate" means to the person who clicked it.
          if (action === "DEACTIVATE") {
            await prisma.session.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
          }
          break;
        }
        case "RESET_PASSWORD": {
          // No explicit password → a per-person random one (never a fixed default: the old
          // "Admin@12345" fallback is documented in this repo's README, and a default anyone
          // can read is not a password). Either way the person is prompted to choose their own
          // at next sign-in via mustChangePassword.
          const nextPassword = password || generateTempPassword();
          await prisma.user.update({
            where: { id: target.id },
            data: { passwordHash: await hashPassword(nextPassword), mustChangePassword: true }
          });
          // Same reasoning as the emailed-reset path (auth.service.ts#resetPassword): the reason
          // an admin resets somebody's password is usually that the account is compromised, and
          // a new hash alone evicts nobody — an attacker's refresh token keeps rotating for the
          // rest of the session's 30 days. ALL sessions, not "all but the current": the actor
          // here is the admin, never the target.
          await prisma.session.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
          if (!password) {
            generatedPasswords.push({ id: target.id, name: target.name, email: target.email, password: nextPassword });
          }
          break;
        }
        case "RESEND_WELCOME": {
          if (target.status !== "ACTIVE") {
            skipped.push({ id: target.id, name: target.name, reason: "Not active" });
            continue;
          }
          const result = await sendWelcomeEmail(target);
          if (!result.ok) {
            skipped.push({ id: target.id, name: target.name, reason: result.errorMessage ?? "SMTP refused the message" });
            continue;
          }
          break;
        }
        case "FORCE_LOGOUT":
          await prisma.session.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
          break;
        case "DELETE":
          await prisma.user.update({ where: { id: target.id }, data: { deletedAt: new Date(), status: "INACTIVE" } });
          await prisma.session.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
          break;
      }
      done.push(target.id);
    } catch (err) {
      skipped.push({ id: target.id, name: target.name, reason: (err as Error)?.message ?? "Failed" });
    }
  }

  // One audit row for the operation plus the target list, rather than N rows: "who ran a bulk
  // deactivate over 60 people" is the question an auditor actually asks, and it is unanswerable
  // from sixty individual rows that look identical to sixty separate clicks.
  await audit(req.user!.id, `user.bulk_${action.toLowerCase()}`, "User", undefined, {
    requested: targets.length,
    applied: done.length,
    skipped: skipped.length,
    selection: userIds?.length ? "explicit" : "filter",
    userIds: done
  });
  // Once for the batch, not per person: Stripe needs the final headcount, not sixty steps to it.
  if (SEAT_CHANGING_ACTIONS.has(action) && done.length > 0) await syncSeatsAfterChange();

  res.json({ applied: done.length, requested: targets.length, skipped, generatedPasswords });
});

/**
 * Force-sign-out ONE user: revokes every unrevoked session they have, server-side. Their next
 * request 401s, the refresh fails, and they're back at /login — the same no-client-cooperation
 * chain as maintenance mode's bulk force-logout, scoped to one person.
 * Guard: only a SUPER_ADMIN may sign out a SUPER_ADMIN — otherwise an ADMIN with users:manage
 * could bounce the one role that outranks them.
 */
userRouter.post("/:id/force-logout", async (req, res) => {
  const id = String(req.params.id);
  const target = await loadAuthorityTarget(id);
  if (target.deletedAt) throw new AppError(404, "User not found");
  assertMayActOn(req.user!, target);

  const result = await prisma.session.updateMany({
    where: { userId: id, revokedAt: null },
    data: { revokedAt: new Date() }
  });
  await audit(req.user!.id, "user.force_logout", "User", id, { revokedSessions: result.count });
  res.json({ revokedSessions: result.count });
});

userRouter.post(
  "/",
  validate(
    z.object({
      body: z.object({
        name: z.string().min(2),
        email: z.string().email(),
        role: z.string(),
        // Every role this account may hold/switch into — SUPER_ADMIN-only (checked in the
        // handler, since USERS_MANAGE alone also covers ADMIN). Omitted (the common case): the
        // account gets exactly the one `role` above, matching this route's pre-multi-role
        // behavior exactly.
        roles: z.array(z.enum(roles)).min(1).optional(),
        // OPTIONAL, and normally omitted. Every other password path in this file — bulk reset, CSV
        // import, /:id/reset-password — generates a random one-time password rather than accepting
        // a default, for the reason written on `generateTempPassword`: the fixed "Admin@12345" this
        // repo's own README documents is not a password. This route was the last one still
        // demanding a caller-supplied value, and the admin UI satisfied it by pre-filling exactly
        // that string, so every user created through the form shared one publicly-known password.
        password: z.string().min(8).optional(),
        managerId: z.string().uuid().optional().nullable(),
        designation: z.string().max(120).optional().nullable(),
        faceVerificationRequired: z.boolean().optional(),
        githubUsername: z.string().max(120).optional().nullable()
      })
    })
  ),
  async (req, res) => {
    const actorIsSuperAdmin = req.user!.role === "SUPER_ADMIN";
    if (req.body.roles && !actorIsSuperAdmin) {
      throw new AppError(403, "Only a super admin can grant more than one role.");
    }
    if (req.body.roles && !req.body.roles.includes(req.body.role)) {
      throw new AppError(422, "The active role must be one of the granted roles.");
    }
    // `roles` is already super-admin-only above; the plain `role` field was not, so an ADMIN could
    // create a SUPER_ADMIN — a superior it then had the password of.
    assertMayGrant(req.user!, [req.body.role]);
    // Plan-tier seat enforcement — re-checked on every creation (not cached) so a platform
    // admin lowering a tier's seat limit, or an org outgrowing its plan, takes effect
    // immediately rather than after some reconciliation job. Counts the same population
    // platform-admin-analytics.service.ts reports as "seats" (ACTIVE, not soft-deleted), so
    // the number an org sees in the console and the number enforced here always agree.
    await assertSeatAvailable(
      1,
      ({ limit }) => `Seat limit reached (${limit} seats on the current plan). Contact your platform administrator to add more seats.`
    );

    // Explicit duplicate check instead of letting the unique index throw: a P2002 here used to
    // surface as an unhandled 500, and the soft-delete case is genuinely non-obvious to the
    // admin — the colliding account is invisible in every list.
    const existing = await prisma.user.findUnique({ where: { email: req.body.email }, select: { deletedAt: true } });
    if (existing) {
      throw new AppError(
        409,
        existing.deletedAt
          ? "This email belongs to a deleted account (kept for audit history), so it can't be reused."
          : "A user with this email already exists."
      );
    }

    const role = await prisma.role.findUniqueOrThrow({ where: { name: req.body.role } });
    if (req.body.managerId) {
      const manager = await prisma.user.findUnique({ where: { id: req.body.managerId } });
      if (!manager) throw new AppError(422, "Manager not found");
    }
    // Returned ONCE in the response below and stored nowhere in plaintext, exactly as
    // /:id/reset-password does it. Null when the admin supplied their own — they already know it.
    const generatedPassword = req.body.password ? null : generateTempPassword();
    const user = await prisma.user.create({
      data: {
        name: req.body.name,
        email: req.body.email,
        roleId: role.id,
        status: "ACTIVE",
        passwordHash: await hashPassword(req.body.password ?? generatedPassword!),
        // The admin knows this password; the person it belongs to should not keep it. Prompts
        // (never forces) a change at first sign-in.
        mustChangePassword: true,
        managerId: req.body.managerId ?? undefined,
        designation: req.body.designation ?? undefined,
        faceVerificationRequired: req.body.faceVerificationRequired ?? undefined,
        githubUsername: req.body.githubUsername ?? undefined,
        notificationPreference: { create: {} }
      }
    });
    await replaceHeldRoles(user.id, req.body.roles ?? [req.body.role as RoleName]);
    await audit(req.user!.id, "user.created", "User", user.id);
    // The billed seat count follows the real one (services/seats.service.ts — never throws).
    await syncSeatsAfterChange();

    const welcomeResult = await sendWelcomeEmail(user);
    await audit(
      req.user!.id,
      welcomeResult.ok ? "user.welcome_sent" : "user.welcome_failed",
      "User",
      user.id,
      welcomeResult.errorMessage ? { error: welcomeResult.errorMessage } : undefined
    );

    // `passwordHash` stripped, matching every list route in this file. Prisma's create returns all
    // scalars, so spreading the record put the new account's bcrypt hash in the admin's browser and
    // in whatever proxy logs sit between — a leak with no purpose, since the admin either chose the
    // password or gets it back below in plaintext.
    // eslint-disable-next-line sonarjs/no-unused-vars -- rest-sibling omit pattern
    const { passwordHash: _passwordHash, ...created } = user;
    res.status(201).json({
      ...created,
      generatedPassword,
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

  await assertSeatAvailable(
    rows.length,
    ({ limit, used }) =>
      `This upload would create ${rows.length} users, exceeding the seat limit (${limit} seats, ${used} already used). Reduce the file or contact your platform administrator.`
  );
  const roles = await prisma.role.findMany();
  const roleByName = new Map<string, (typeof roles)[number]>(roles.map((r) => [r.name, r]));

  const results: Array<{ row: number; email: string; success: boolean; error?: string; userId?: string }> = [];
  const emailToId = new Map<string, string>();

  // Pass 1 — create every valid row without a manager link yet.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const role = roleByName.get(row.role);
      if (!role) throw new Error(`Unknown role "${row.role}"`);
      // Per row, like every other refusal here: one SUPER_ADMIN line from an ADMIN must not block
      // the forty employees in the same file.
      const refusal = grantRefusal(req.user!, [row.role]);
      if (refusal) throw new Error(refusal);
      const existing = await prisma.user.findUnique({ where: { email: row.email } });
      if (existing) throw new Error("A user with this email already exists");

      const user = await prisma.user.create({
        data: {
          name: row.name,
          email: row.email,
          roleId: role.id,
          status: "ACTIVE",
          passwordHash: await hashPassword(row.password && row.password.length >= 8 ? row.password : generateTempPassword()),
          // Whether the CSV carried a password (the uploader knows it) or one was generated
          // (nobody knows it — an admin reset hands it over later), the person should choose
          // their own at first sign-in.
          mustChangePassword: true,
          designation: row.designation || undefined,
          githubUsername: row.githubUsername || undefined,
          notificationPreference: { create: {} },
          // The account holds the role it was created with — see services/user-authority.service.ts
          // for why a missing row mattered. Nested, so the user and the row land together.
          userRoles: { create: { roleId: role.id } }
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
  // Once for the whole file — the import used to leave Stripe billing the pre-upload headcount.
  if (createdUsers.length > 0) await syncSeatsAfterChange();

  res.status(201).json({ results });
});

const patchSchema = z.object({
  body: z.object({
    name: z.string().min(2).optional(),
    email: z.string().email().optional(),
    status: z.enum(["ACTIVE", "INACTIVE", "PENDING_VERIFICATION"]).optional(),
    role: z.string().optional(),
    // SUPER_ADMIN-only (checked in the handler) — every role this account may hold/switch into.
    // Omitted: the plain `role` field above means "exactly this one role", same as before this
    // existed — only this array can produce more than one held role.
    roles: z.array(z.enum(roles)).min(1).optional(),
    managerId: z.string().uuid().nullable().optional(),
    designation: z.string().max(120).nullable().optional(),
    faceVerificationRequired: z.boolean().optional(),
    githubUsername: z.string().max(120).nullable().optional()
  })
});

/**
 * The held-role set a PATCH leaves the account with, or null when the call does not touch roles —
 * the held set is then left exactly as-is.
 */
function heldRolesAfterPatch(currentHeld: RoleName[], body: { role?: string; roles?: string[] }): RoleName[] | null {
  // The SUPER_ADMIN-only `roles` array, already validated by the caller — a full replace.
  if (body.roles) return body.roles as RoleName[];
  if (!body.role) return null;
  if (currentHeld.length > 1) {
    // A genuinely multi-role account: the plain field can only switch which already-granted role is
    // active — it can never silently grant or revoke a role on the side. Granting a NEW role onto a
    // multi-role account requires the explicit, SUPER_ADMIN-only `roles` array.
    if (!currentHeld.includes(body.role as RoleName)) {
      throw new AppError(422, "This account holds multiple roles — use the roles field to grant a new one.");
    }
    return null;
  }
  // The common case (one held role, true for every account before this feature and for every
  // account nobody has explicitly granted a second role to): the plain field means exactly what it
  // always has — this is now the account's one and only role.
  return [body.role as RoleName];
}

/**
 * The two ways a PATCH can take access away for good: you, from yourself (deactivating your own
 * account, or dropping a role you hold), and anyone, from the workspace's last active super admin.
 * Echoing your own unchanged role and ACTIVE status back — which the edit dialog always does — is
 * neither, and passes.
 */
async function assertPatchKeepsAccess(
  actor: { id: string; role: string },
  target: AuthorityTarget,
  after: { heldRoles: RoleName[] | null; status?: string }
): Promise<void> {
  if (after.status && after.status !== "ACTIVE") assertNotSelfLockout(actor, target.id, "deactivate");
  const dropsARole = after.heldRoles !== null && target.heldRoles.some((role) => !after.heldRoles!.includes(role));
  if (dropsARole) assertNotSelfLockout(actor, target.id, "demote");
  await assertNotLastSuperAdmin(target, after);
}

userRouter.patch("/:id", validate(patchSchema), async (req, res) => {
  const targetId = String(req.params.id);
  const actorIsSuperAdmin = req.user!.role === "SUPER_ADMIN";

  if (req.body.roles && !actorIsSuperAdmin) {
    throw new AppError(403, "Only a super admin can grant more than one role.");
  }
  if (req.body.roles && !req.body.role) {
    throw new AppError(422, "An active role is required when granting a set of roles.");
  }
  if (req.body.roles && req.body.role && !req.body.roles.includes(req.body.role)) {
    throw new AppError(422, "The active role must be one of the granted roles.");
  }

  const row = await prisma.user.findUnique({
    where: { id: targetId },
    select: { ...AUTHORITY_TARGET_SELECT, faceVerificationRequired: true, isAgent: true }
  });
  if (!row) throw new AppError(404, "User not found");
  const target = toAuthorityTarget(row);
  // EVERY field, not only the role: an ADMIN who may change a super admin's email can send that
  // address's password reset to themselves, and one who may set their status can lock them out.
  assertMayActOn(req.user!, target);
  if (req.body.role) assertMayGrant(req.user!, [req.body.role]);

  const newHeldRoleNames = heldRolesAfterPatch(target.heldRoles, req.body);
  await assertPatchKeepsAccess(req.user!, target, { heldRoles: newHeldRoleNames, status: req.body.status });
  // Reactivating somebody takes a seat exactly as creating them does — it was checked on creation
  // only, so deactivate-then-reactivate walked straight past a full plan.
  if (takesASeat(row, req.body.status)) await assertSeatAvailable(1);

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
    if (req.body.managerId && req.body.managerId === targetId) {
      throw new AppError(422, "A user cannot be their own manager");
    }
    data.managerId = req.body.managerId ?? null;
  }

  const user = await prisma.user.update({ where: { id: targetId }, data, include: { role: true } });
  if (newHeldRoleNames) await replaceHeldRoles(user.id, newHeldRoleNames);
  await audit(req.user!.id, "user.updated", "User", user.id, req.body);
  if (req.body.status && req.body.status !== row.status) await syncSeatsAfterChange();

  // The person just became individually covered by the face policy — tell them now, not at
  // their next blocked submission. Compared against the row read before the write, so the prompt
  // only fires on the false→true transition, not on every PATCH that echoes the field back.
  // notifyEnrollmentRequired no-ops unless the policy is live (feature enabled + an action
  // requires it + plan entitlement) and they're unenrolled.
  if (data.faceVerificationRequired === true && !row.faceVerificationRequired) {
    findCoveredUnenrolledUserIds()
      .then((ids) => (ids.includes(user.id) ? notifyEnrollmentRequired([user.id]) : 0))
      .catch(() => undefined);
  }

  res.json(user);
});

userRouter.delete("/:id", async (req, res) => {
  const id = String(req.params.id);
  const target = await loadAuthorityTarget(id);
  assertMayActOn(req.user!, target);
  assertNotSelfLockout(req.user!, id, "delete");
  await assertNotLastSuperAdmin(target, { deleted: true });
  await prisma.user.update({ where: { id }, data: { deletedAt: new Date(), status: "INACTIVE" } });
  // Removing somebody frees a seat, and a customer who is billed for people who left will
  // notice long before they mention it.
  await syncSeatsAfterChange();
  // The bulk DELETE path (POST /bulk) already does this; the single-user route didn't, which
  // left the deleted person's Session rows alive and refreshable.
  await prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(req.user!.id, "user.deleted", "User", id);
  res.status(204).send();
});

userRouter.post("/:id/reset-password", async (req, res) => {
  // This route hands the new password back in plaintext, so it is the sharpest one to leave open:
  // an ADMIN resetting a SUPER_ADMIN here could sign in as them. Checked before anything is written.
  assertMayActOn(req.user!, await loadAuthorityTarget(String(req.params.id)));
  // No password supplied → generate a random one-time password and return it ONCE in this
  // response (it is stored only as a hash). The old behavior defaulted to "Admin@12345", which
  // this repo's own README documents — a default the whole internet can read is not a password.
  const provided = typeof req.body.password === "string" && req.body.password.length >= 8 ? req.body.password : null;
  const password = provided ?? generateTempPassword();
  await prisma.user.update({
    where: { id: String(req.params.id) },
    // Admin-known passwords are temporary by definition — prompt the person to pick their own.
    data: { passwordHash: await hashPassword(password), mustChangePassword: true }
  });
  // See the bulk RESET_PASSWORD case: a new hash on its own does not evict whoever prompted the
  // reset, so every session of the target ends here — including the one on their own phone.
  await prisma.session.updateMany({
    where: { userId: String(req.params.id), revokedAt: null },
    data: { revokedAt: new Date() }
  });
  await audit(req.user!.id, "user.password_reset", "User", String(req.params.id));
  res.json({
    message: "Password reset. They've been signed out everywhere.",
    generatedPassword: provided ? null : password
  });
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
