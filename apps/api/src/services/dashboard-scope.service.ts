/**
 * WHAT: the projects a custom dashboard's widgets resolve against for a given viewer.
 *
 * WHY IT IS SHARED: the live dashboard (controllers/dashboard.controller.ts) and its scheduled email
 * (workers/report-subscription.worker.ts) must answer this identically, and did not. The live view
 * used `ticketProjectScope` — a MANAGER or TEAM_LEAD also sees their direct reports' projects — while
 * the worker rebuilt a narrower rule from the owner's own assignments and primary role name. So a team
 * lead's emailed copy of a dashboard covered fewer projects than the same dashboard on screen. Both
 * now take a request-shaped principal (`requireAuth`'s `req.user`, or `loadRequestUser` for the
 * worker, which carries the ACTIVE role) and call this.
 */
import type { RequestUser } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";
import { ticketProjectScope } from "./ticket.service.js";

export async function dashboardProjectIds(principal: Pick<RequestUser, "id" | "role">): Promise<string[]> {
  const scope = await ticketProjectScope({ user: principal });
  if (!scope.unrestricted) return scope.projectIds;
  const all = await prisma.project.findMany({ where: { deletedAt: null }, select: { id: true } });
  return all.map((p) => p.id);
}
