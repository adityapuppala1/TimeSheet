/**
 * Auth for the MCP endpoint (controllers/mcp.controller.ts).
 *
 * WHY NOT `publicApiAuth`: that middleware authenticates an `ApiKey` and sets `{ id, scope }` —
 * no acting user at all. A coarse read API can live with that. Tools that ACT cannot, because
 * every authorization helper in this codebase decides from `req.user`: `requirePermission`,
 * `ticketProjectScope`, `assertTicketVisible`, `canModifyTicket`, `team.controller.ts`'s
 * `managerId` predicate, `project.controller.ts`'s `visibilityScope`. A caller with no `req.user`
 * would have to skip all of them, and an MCP client that skips the RBAC model is an MCP client
 * with more authority than the person who set it up. So an MCP credential is bound to exactly one
 * user (prisma/schema.prisma#McpCredential) and this middleware resolves it into the same
 * `RequestUser` shape `middleware/auth.ts#requireAuth` builds.
 *
 * WHO resolves the tenant: nobody here. This router is mounted AFTER the blanket `resolveTenant`
 * in app.ts, exactly like the public REST API — an MCP client connects to its own workspace's URL
 * (`acme.timesphere.app/api/mcp`), so the Host header already decided which database `prisma`
 * talks to before this runs. That is why no tool takes an org parameter: there is nowhere for one
 * to have an effect.
 */
import type { NextFunction, Request, Response } from "express";
import { AppError } from "./error.js";
import { resolveMcpPrincipal, type McpPrincipal } from "../services/mcp.service.js";

export interface McpRequest extends Request {
  mcp?: McpPrincipal;
}

export async function mcpAuth(req: McpRequest, res: Response, next: NextFunction) {
  const headerRaw = req.headers.authorization;
  const header = (Array.isArray(headerRaw) ? headerRaw[0] : headerRaw) ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();

  // The header MCP clients look for when deciding whether they need to prompt for a credential.
  res.setHeader("WWW-Authenticate", 'Bearer realm="TimeSphere MCP"');

  if (!token) {
    throw new AppError(401, "Missing MCP credential. Pass it as 'Authorization: Bearer <token>'.");
  }

  const principal = await resolveMcpPrincipal(token);
  // One message for every failure mode — unknown token, revoked, deactivated account, workspace in
  // maintenance — so this endpoint cannot be used to enumerate which tokens or users exist.
  if (!principal) throw new AppError(401, "Invalid or revoked MCP credential.");

  req.mcp = principal;
  next();
}
