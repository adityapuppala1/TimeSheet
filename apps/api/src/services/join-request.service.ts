/**
 * WHAT: requests to join a workspace from somebody whose company already has one (signup Phase 1,
 * docs/SIGNUP_AND_DOMAINS_PLAN.md §5.3). Asked from the public signup page (`POST /api/signup/join`),
 * decided on Users → Requests by anyone who may create users.
 *
 * WHY IT LIVES IN THE TENANT DATABASE. A request is the workspace's business: its admins decide it,
 * its audit log records it, and it leaves with the workspace when the workspace is deleted. Nothing
 * about it is cross-tenant, so nothing about it goes in the control plane.
 *
 * The rules, each of which is a way a stranger ends up with the wrong access or a workspace pays for
 * a seat twice:
 *  - one PENDING request per address; an address that already has an account is told so;
 *  - approval re-checks the seat limit and the workspace's status AT APPROVAL — both can change in
 *    the fourteen days a request may wait;
 *  - someone who became a member meanwhile is LINKED, never given a second account or a second seat;
 *  - a new account is an EMPLOYEE unless a super admin chooses otherwise (the same rule as `roles`
 *    on user create), and it has no password anybody knows: approval mails a single-use 72-hour link;
 *  - expiry is lazy — a PENDING row past `expiresAt` is written EXPIRED the next time anything reads
 *    it, so no job has to run for the Requests tab to be right.
 */
import type { RoleName } from "@prisma/client";
import { controlPrisma } from "../config/control-prisma.js";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { AppError } from "../middleware/error.js";
import { hashPassword, opaqueToken } from "../utils/security.js";
import { audit } from "./audit.service.js";
import { syncSubscriptionSeats } from "./billing-sync.service.js";
import { emailShell, templates } from "./mail-templates.js";
import { dispatchInAppToMany, dispatchTransactional } from "./notify.service.js";
import { getEffectiveSeatLimit } from "./plan-limits.service.js";
import { countActiveSeats } from "./seat-count.service.js";
import { issueSetPasswordLink } from "./set-password-link.service.js";
import { rememberWorkspaceMembership, tenantBaseUrl } from "./workspace-directory.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** "Your request was approved" can sit in an inbox over a weekend; a reset link's 30 minutes cannot. */
export const SET_PASSWORD_TTL_MS = 72 * 60 * 60 * 1000;
const REVIEW_PATH = "/app/users?tab=requests";

export type JoinRequestFilter = "pending" | "decided";

export interface CreateJoinRequestInput {
  email: string;
  name: string;
  message?: string | null;
  ttlDays: number;
  workspaceName: string;
  now?: Date;
}

/** Writes every PENDING request past its expiry as EXPIRED. Returns nothing: callers re-read. */
async function expireOverdue(now: Date, where: { email?: string; id?: string } = {}) {
  await prisma.joinRequest.updateMany({ where: { ...where, status: "PENDING", expiresAt: { lte: now } }, data: { status: "EXPIRED" } });
}

/** Must run inside the workspace's tenant context (`withOrgTenant`). Never throws for a notification
 *  failure — the request exists by then, and a 500 would tell the person it does not. */
export async function createJoinRequest(input: CreateJoinRequestInput): Promise<{ status: "requested" | "already_pending" | "member"; id?: string }> {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, deletedAt: true } });
  // An ARCHIVED account is not a member: it cannot sign in. Its request goes to the admins, whose
  // approval then tells them to restore the account from Users rather than mint a second one.
  if (existing && !existing.deletedAt) return { status: "member" };

  await expireOverdue(now, { email });
  const pending = await prisma.joinRequest.findFirst({ where: { email, status: "PENDING" }, select: { id: true } });
  if (pending) return { status: "already_pending", id: pending.id };

  const message = input.message?.trim() || null;
  const row = await prisma.joinRequest.create({
    data: { email, name: input.name.trim(), message, expiresAt: new Date(now.getTime() + input.ttlDays * DAY_MS) }
  });

  try {
    await tellDeciders(row, input.workspaceName);
  } catch (error) {
    console.error(`[join-request] request ${row.id} saved, but telling the admins failed:`, error);
  }
  return { status: "requested", id: row.id };
}

/**
 * Who hears about a new request: the active super admins — or, in a workspace that has none (the
 * last one left or was deactivated), its active admins, who hold `users:manage` and can decide it.
 * Telling nobody would leave a person waiting on a tab no one knows to open.
 */
async function decidersToTell() {
  const select = { id: true, email: true, name: true };
  const active = { status: "ACTIVE" as const, deletedAt: null, isAgent: false };
  const superAdmins = await prisma.user.findMany({ where: { ...active, role: { name: "SUPER_ADMIN" } }, select });
  if (superAdmins.length > 0) return superAdmins;
  return prisma.user.findMany({ where: { ...active, role: { name: "ADMIN" } }, select });
}

async function tellDeciders(row: { email: string; name: string; message: string | null }, workspaceName: string) {
  const deciders = await decidersToTell();
  if (deciders.length === 0) return;

  await dispatchInAppToMany({
    userIds: deciders.map((admin) => admin.id),
    category: "join.requested",
    title: `${row.name} asked to join`,
    body: `${row.email} proved they own an address at your company's domain. Approve or decline on Users → Requests.`,
    link: REVIEW_PATH
  });

  const reviewUrl = `${tenantBaseUrl()}${REVIEW_PATH}`;
  const raw = { requesterName: row.name, requesterEmail: row.email, message: row.message ?? "", workspaceName, reviewUrl };
  // The name and message are a STRANGER's free text. The compiled fallback escapes them itself; an
  // admin-edited override substitutes `vars` verbatim (template-store.service.ts#applyVars), so they
  // go in escaped too. Cost: an override's SUBJECT shows `&amp;` for a name with an ampersand.
  const { escape } = emailShell;
  const vars = { requesterName: escape(row.name), requesterEmail: escape(row.email), message: escape(row.message), workspaceName: escape(workspaceName), reviewUrl };
  for (const admin of deciders) {
    await dispatchTransactional({
      to: admin.email,
      templateKey: "workspace.join_request",
      vars,
      fallback: { subject: `${row.name} asked to join ${workspaceName}`, html: templates.joinRequest(raw) }
    });
  }
}

/** Requests written since `since`, whatever became of them — the daily cap on /api/signup/join.
 *  Tenant context required. */
export async function countJoinRequestsSince(since: Date): Promise<number> {
  return prisma.joinRequest.count({ where: { createdAt: { gte: since } } });
}

export async function listJoinRequests(filter: JoinRequestFilter, now = new Date()) {
  await expireOverdue(now);
  if (filter === "pending") {
    return prisma.joinRequest.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 200 });
  }
  return prisma.joinRequest.findMany({
    where: { status: { in: ["APPROVED", "DECLINED", "EXPIRED"] } },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: { decidedBy: { select: { id: true, name: true } } }
  });
}

/** Loads a request that may still be decided, or throws the reason it may not. */
async function loadPending(id: string, now: Date) {
  const row = await prisma.joinRequest.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Join request not found");
  if (row.status === "PENDING" && row.expiresAt <= now) {
    await expireOverdue(now, { id });
    throw new AppError(409, "This request expired before anyone decided it. They can ask again from the signup page.");
  }
  if (row.status !== "PENDING") throw new AppError(409, `This request was already ${row.status.toLowerCase()}.`);
  return row;
}

async function workspaceOrThrow(orgId: string) {
  const org = await controlPrisma.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true, status: true } });
  if (!org) throw new AppError(404, "Workspace not found");
  return org;
}

export async function approveJoinRequest(
  id: string,
  actor: { id: string; role: string },
  options: { orgId: string; role?: RoleName; now?: Date }
): Promise<{ userId: string; linked: boolean }> {
  const now = options.now ?? new Date();
  const role: RoleName = options.role ?? "EMPLOYEE";
  if (role !== "EMPLOYEE" && actor.role !== "SUPER_ADMIN") {
    throw new AppError(403, "Only a super admin can approve someone as more than an Employee.");
  }

  const row = await loadPending(id, now);
  const org = await workspaceOrThrow(options.orgId);
  // Join requests are taken only while the workspace is ACTIVE (the plan's decision 3); approving one
  // in GRACE or SUSPENDED would add a seat to a workspace that is not being paid for.
  if (org.status !== "ACTIVE") {
    throw new AppError(409, "This workspace is not active, so it cannot take new members right now.", { code: "WORKSPACE_UNAVAILABLE" });
  }

  const existing = await prisma.user.findUnique({ where: { email: row.email }, select: { id: true, status: true, deletedAt: true } });
  if (existing) {
    if (existing.deletedAt || existing.status !== "ACTIVE") {
      throw new AppError(409, "This address belongs to an archived or deactivated account. Restore it from Users instead of approving the request.");
    }
    return linkExistingMember(row, existing.id, actor.id, org.name, now);
  }

  const [seatLimit, activeSeats] = await Promise.all([getEffectiveSeatLimit(options.orgId), countActiveSeats()]);
  if (activeSeats >= seatLimit) {
    throw new AppError(402, `Seat limit reached (${seatLimit} seats on the current plan). Free a seat, or ask your platform administrator for more, then approve again.`);
  }

  const roleRow = await prisma.role.findUniqueOrThrow({ where: { name: role } });
  // A password nobody knows: a random 48-character token, hashed and discarded. The person sets their
  // own through the emailed link, so `mustChangePassword` stays false — there is nothing to change.
  const passwordHash = await hashPassword(opaqueToken());
  let userId: string;
  try {
    userId = await prisma.$transaction(async (tx) => {
      // Conditional on PENDING: two admins approving at once — one wins, the other gets the 409.
      const claimed = await tx.joinRequest.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "APPROVED", decidedById: actor.id, decidedAt: now, roleGranted: role }
      });
      if (claimed.count === 0) throw new AppError(409, "Someone else decided this request a moment ago.");
      const user = await tx.user.create({
        data: {
          name: row.name,
          email: row.email,
          roleId: roleRow.id,
          status: "ACTIVE",
          passwordHash,
          mustChangePassword: false,
          // They proved the address to the signup page before they could ask.
          emailVerifiedAt: now,
          notificationPreference: { create: {} }
        }
      });
      await tx.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
      await tx.joinRequest.update({ where: { id }, data: { createdUserId: user.id } });
      return user.id;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      throw new AppError(409, "An account with this address was created a moment ago. Approve again to link it.");
    }
    throw error;
  }

  await audit(actor.id, "join_request.approved", "JoinRequest", id, { userId, role });
  await syncSubscriptionSeats(options.orgId);
  await rememberWorkspaceMembership(options.orgId, row.email);
  // A workspace that refuses passwords at sign-in (SSO only, or password login switched off) gets the
  // sign-in page, where its identity provider's button is — not a link to choose a password the login
  // form would then refuse. No link is issued at all there: an unused credential is still one.
  if (await passwordSignInRefused(options.orgId)) {
    await mailApproved(row, org.name, `${tenantBaseUrl()}/login`, "Sign in with your company account");
  } else {
    const actionUrl = await issueSetPasswordLink(userId, SET_PASSWORD_TTL_MS);
    await mailApproved(row, org.name, actionUrl, "Choose your password");
  }
  return { userId, linked: false };
}

/** The same test auth.service.ts#login refuses a password sign-in on — keep the two in step. */
async function passwordSignInRefused(orgId: string): Promise<boolean> {
  const method = await controlPrisma.orgAuthMethod.findUnique({ where: { organizationId: orgId }, select: { requireSsoOnly: true, passwordLoginEnabled: true } });
  return Boolean(method && (method.requireSsoOnly || !method.passwordLoginEnabled));
}

async function linkExistingMember(row: { id: string; email: string; name: string }, userId: string, actorId: string, workspaceName: string, now: Date) {
  const claimed = await prisma.joinRequest.updateMany({
    where: { id: row.id, status: "PENDING" },
    data: { status: "APPROVED", decidedById: actorId, decidedAt: now, createdUserId: userId }
  });
  if (claimed.count === 0) throw new AppError(409, "Someone else decided this request a moment ago.");
  await audit(actorId, "join_request.approved", "JoinRequest", row.id, { userId, linked: true });
  await mailApproved(row, workspaceName, `${tenantBaseUrl()}/login`, "Sign in");
  return { userId, linked: true };
}

async function mailApproved(row: { email: string; name: string }, workspaceName: string, actionUrl: string, actionLabel: string) {
  // The compiled fallback escapes what it prints; an admin-edited override substitutes `vars`
  // verbatim (template-store.service.ts#applyVars), so the names go in escaped too — the house
  // convention (security-report.service.ts does the same). The link and its label are ours.
  const { escape } = emailShell;
  await dispatchTransactional({
    to: row.email,
    templateKey: "workspace.join_approved",
    vars: { name: escape(row.name), workspaceName: escape(workspaceName), actionUrl, actionLabel },
    fallback: {
      subject: `You're in: ${workspaceName} approved your request`,
      html: templates.joinApproved({ name: row.name, workspaceName, actionUrl, actionLabel })
    },
    // The body carries a single-use set-password link — see mail.service.ts#SendArgs.sensitive.
    sensitive: true
  });
}

export async function declineJoinRequest(id: string, actorId: string, note?: string, now = new Date()): Promise<void> {
  const row = await loadPending(id, now);
  // Read BEFORE the write: if the control plane cannot be reached, nothing is recorded and the
  // admin can simply decline again — rather than a decline saved with its email never sent.
  const org = await workspaceOrThrow(requireTenantContext().orgId);
  const decisionNote = note?.trim() || null;
  const claimed = await prisma.joinRequest.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "DECLINED", decidedById: actorId, decidedAt: now, decisionNote }
  });
  if (claimed.count === 0) throw new AppError(409, "Someone else decided this request a moment ago.");
  await audit(actorId, "join_request.declined", "JoinRequest", id, { email: row.email, withNote: Boolean(decisionNote) });

  const raw = { name: row.name, workspaceName: org.name, note: decisionNote ?? "" };
  const { escape } = emailShell;
  await dispatchTransactional({
    to: row.email,
    templateKey: "workspace.join_declined",
    // Escaped for an edited override, raw for the fallback that escapes itself — as mailApproved.
    vars: { name: escape(raw.name), workspaceName: escape(raw.workspaceName), note: escape(raw.note) },
    fallback: { subject: `Your request to join ${org.name}`, html: templates.joinDeclined(raw) }
  });
}
