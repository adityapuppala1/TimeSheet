/**
 * WHAT: Users → Requests — the workspace side of a join request (signup Phase 1,
 * docs/SIGNUP_AND_DOMAINS_PLAN.md §5.3). The rules live in join-request.service.ts; this file is
 * only who may call them and with what.
 *
 * WHO: anyone holding `users:manage`, because approving creates an account — the same gate as
 * creating one by hand on Users. Granting more than EMPLOYEE is a super admin's call, enforced in
 * the service so the rule holds for any future caller too.
 *
 * The workspace id passed to approval is the TENANT CONTEXT's, never the body's: a request cannot
 * name a different workspace to check seats or status against.
 */
import { permissions, roles } from "@timesheet/shared";
import { Router } from "express";
import { z } from "zod";
import { requireTenantContext } from "../config/tenant-context.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { approveJoinRequest, declineJoinRequest, listJoinRequests, type JoinRequestFilter } from "../services/join-request.service.js";

export const joinRequestRouter = Router();
joinRequestRouter.use(requireAuth, requirePermission(permissions.USERS_MANAGE));

const listSchema = z.object({ query: z.object({ filter: z.enum(["pending", "decided"]).optional() }) });
const approveSchema = z.object({ body: z.object({ role: z.enum(roles).optional() }) });
const declineSchema = z.object({ body: z.object({ note: z.string().max(500).optional() }) });

joinRequestRouter.get("/", validate(listSchema), async (req, res) => {
  const filter = (req.query.filter as JoinRequestFilter | undefined) ?? "pending";
  res.json(await listJoinRequests(filter));
});

joinRequestRouter.post("/:id/approve", validate(approveSchema), async (req, res) => {
  const result = await approveJoinRequest(String(req.params.id), { id: req.user!.id, role: req.user!.role }, {
    orgId: requireTenantContext().orgId,
    role: req.body?.role
  });
  res.json(result);
});

joinRequestRouter.post("/:id/decline", validate(declineSchema), async (req, res) => {
  await declineJoinRequest(String(req.params.id), req.user!.id, req.body?.note);
  res.status(204).end();
});
