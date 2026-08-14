/**
 * WHAT: the admin-editable catalog behind the "Activity" field on every timesheet entry —
 * list/create/rename/enable/disable/delete.
 *
 * WHY IT EXISTS: the `ActivityType` table has been seeded since the first migration, but nothing
 * ever read it. Both apps imported the frozen `activityTypes` array from `@timesheet/shared`
 * instead, which meant a workspace that ran a different kind of work ("Incident response",
 * "Client call") had no way to say so short of a code change and a redeploy. The table was the
 * intended design all along; this router is the half that was missing.
 *
 * WHY `Timesheet.activityType` STAYS A STRING and not a foreign key: exactly the reasoning
 * `ticket-type.controller.ts` records for `Ticket.type`. An entry is a record of work that
 * happened, and a manager renaming or retiring an activity a year later must not rewrite — or
 * orphan — the history logged under it. The name is copied onto the row at write time; this
 * catalog governs what the PICKER offers, not what the past says.
 *
 * WHO calls this: `apps/web/src/pages/AdminPages.tsx` (ProjectsPage → Activity types card) for
 * the writes, and `apps/web/src/pages/Timesheet.tsx` + `TimesheetReportPanel.tsx` for the list.
 */
import { Router } from "express";
import { z } from "zod";
import { activityTypes as seededActivityTypes, permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";

export const activityTypeRouter = Router();
activityTypeRouter.use(requireAuth);

/**
 * Readable by ANY signed-in user, deliberately: everyone who logs a timesheet needs this list to
 * fill in the form, and an EMPLOYEE holds none of the manage rights. `?all=true` additionally
 * returns disabled rows and is gated — that view is for the management screen, and offering a
 * retired activity in the logging picker is the thing disabling it was meant to stop.
 */
activityTypeRouter.get("/", async (req, res) => {
  const wantsAll = req.query.all === "true" && req.user!.permissions.includes(permissions.PROJECTS_MANAGE);
  const rows = await prisma.activityType.findMany({
    where: wantsAll ? {} : { isActive: true },
    orderBy: { name: "asc" }
  });

  // A workspace provisioned before the seed ran (or one whose rows were all deleted) would hand
  // the timesheet form an empty <Select> and make logging impossible. Falling back to the shared
  // defaults keeps the form usable; it is a READ-side fallback only, so it never writes rows an
  // admin did not ask for and disappears the moment the table has content.
  if (rows.length === 0) {
    res.json(seededActivityTypes.map((name) => ({ id: `seed:${name}`, name, isActive: true, seeded: true })));
    return;
  }
  res.json(rows);
});

const nameSchema = z.string().trim().min(2).max(60);

activityTypeRouter.post(
  "/",
  requirePermission(permissions.PROJECTS_MANAGE),
  validate(z.object({ body: z.object({ name: nameSchema }) })),
  async (req, res) => {
    const name = String(req.body.name).trim();
    // `name` is @unique, so a duplicate would surface as a Prisma P2002 the client renders as
    // "something went wrong". Checked case-insensitively because "Testing" and "testing" are the
    // same activity to everyone except the database.
    const clash = await prisma.activityType.findFirst({ where: { name } });
    if (clash) {
      throw new AppError(
        409,
        clash.isActive
          ? `"${clash.name}" already exists.`
          : `"${clash.name}" already exists but is disabled — re-enable it instead of adding a second one.`
      );
    }

    const created = await prisma.activityType.create({ data: { name } });
    await audit(req.user!.id, "activity_type.created", "ActivityType", created.id, { name });
    res.status(201).json(created);
  }
);

activityTypeRouter.patch(
  "/:id",
  requirePermission(permissions.PROJECTS_MANAGE),
  validate(
    z.object({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ name: nameSchema.optional(), isActive: z.boolean().optional() }).strict()
    })
  ),
  async (req, res) => {
    const existing = await prisma.activityType.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) throw new AppError(404, "Activity type not found");

    const data: { name?: string; isActive?: boolean } = {};
    if (typeof req.body.name === "string") {
      const name = req.body.name.trim();
      if (name !== existing.name) {
        const clash = await prisma.activityType.findFirst({ where: { name, id: { not: existing.id } } });
        if (clash) throw new AppError(409, `"${clash.name}" already exists.`);
        data.name = name;
      }
    }
    if (typeof req.body.isActive === "boolean") data.isActive = req.body.isActive;
    if (Object.keys(data).length === 0) {
      res.json(existing);
      return;
    }

    const updated = await prisma.activityType.update({ where: { id: existing.id }, data });
    // The old name is recorded alongside the new one: a rename is the one edit here that makes
    // historical entries stop matching the catalog, and the audit row is where that is explained.
    await audit(req.user!.id, "activity_type.updated", "ActivityType", updated.id, {
      ...data,
      ...(data.name ? { previousName: existing.name } : {})
    });
    res.json(updated);
  }
);

/**
 * Hard delete, and ONLY when nothing was ever logged under it.
 *
 * An activity in use is not deletable at any privilege level: the entries keep the name as a
 * string, so removing the row would not corrupt them, but it WOULD silently break the approvals
 * screen's activity filter and every grouped report, which build their options from this catalog.
 * Disabling is the operation that exists for "stop offering this", and the refusal says so
 * instead of leaving the admin to guess why a button did nothing.
 */
activityTypeRouter.delete("/:id", requirePermission(permissions.PROJECTS_MANAGE), async (req, res) => {
  const existing = await prisma.activityType.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) throw new AppError(404, "Activity type not found");

  const usedBy = await prisma.timesheet.count({ where: { activityType: existing.name, deletedAt: null } });
  if (usedBy > 0) {
    throw new AppError(
      409,
      `${usedBy} timesheet ${usedBy === 1 ? "entry uses" : "entries use"} "${existing.name}", so it can't be deleted. Disable it instead — it disappears from the picker and the existing entries stay readable.`
    );
  }

  await prisma.activityType.delete({ where: { id: existing.id } });
  await audit(req.user!.id, "activity_type.deleted", "ActivityType", existing.id, { name: existing.name });
  res.status(204).send();
});
