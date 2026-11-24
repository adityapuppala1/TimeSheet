/**
 * 7.0.0 policy scopes and work sites. A leave type or holiday calendar may be scoped to sites
 * (scopeSiteIds, a JSON list). The list is only ever made of ids of existing AttendanceSite rows:
 *
 *   - on save, an unknown id is refused with 422 (a typo or a stale id would silently scope the
 *     policy to nobody);
 *   - when a site is deleted, its id is removed from every scope list in the same transaction. A
 *     list left empty becomes NULL (everyone on that axis), like an empty list on save.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { scopeList } from "./leave-calc.js";

type Db = Pick<typeof prisma, "attendanceSite" | "leaveType" | "holidayCalendar">;

/** Refuses (422) a scope list naming a site that does not exist. Undefined / null / empty pass. */
export async function assertKnownScopeSites(ids: readonly string[] | null | undefined, db: Pick<Db, "attendanceSite"> = prisma): Promise<void> {
  const wanted = [...new Set(ids ?? [])];
  if (wanted.length === 0) return;
  const found = await db.attendanceSite.findMany({ where: { id: { in: wanted } }, select: { id: true } });
  const known = new Set(found.map((s) => s.id));
  const unknown = wanted.filter((id) => !known.has(id));
  if (unknown.length) throw new AppError(422, `Unknown work site: ${unknown.join(", ")}.`, { code: "UNKNOWN_SITE", details: { siteIds: unknown } });
}

/** Removes a deleted site's id from every leave type and holiday calendar scope. Returns rows changed. */
export async function removeSiteFromScopes(siteId: string, db: Db = prisma): Promise<number> {
  let changed = 0;
  const strip = (list: unknown) => {
    const next = scopeList(list).filter((id) => id !== siteId);
    return next.length ? next : Prisma.DbNull;
  };
  const types = await db.leaveType.findMany({ select: { id: true, scopeSiteIds: true } });
  for (const t of types) {
    if (!scopeList(t.scopeSiteIds).includes(siteId)) continue;
    await db.leaveType.update({ where: { id: t.id }, data: { scopeSiteIds: strip(t.scopeSiteIds) } });
    changed += 1;
  }
  const calendars = await db.holidayCalendar.findMany({ select: { id: true, scopeSiteIds: true } });
  for (const c of calendars) {
    if (!scopeList(c.scopeSiteIds).includes(siteId)) continue;
    await db.holidayCalendar.update({ where: { id: c.id }, data: { scopeSiteIds: strip(c.scopeSiteIds) } });
    changed += 1;
  }
  return changed;
}
