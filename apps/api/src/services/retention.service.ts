/**
 * WHAT: the trial retention programme — what happens to a workspace whose free trial ended and
 * nobody paid. A check-in on day 10 of the trial; "your trial has ended, your data is safe" the day
 * it ends; friendly reminders 30, 60, 80 and 90 days later; and, after the retention window, the
 * deletion the policy promised — unless the customer restored the workspace, a platform admin put
 * it on hold, or the kill switch is off.
 *
 * THREE DESIGN RULES, in order of how much they matter:
 *
 * 1. IDEMPOTENT BY RECORD, NOT BY TIMING. Every marker that goes out (or fails to) is written to
 *    `Organization.retentionNoticesSent` with a timestamp, and a marker already recorded is never
 *    sent again by the scheduler. A tick that runs twice, a relay that is down for a week, a
 *    deployment that missed a month — none of them turn into a customer receiving the same "we miss
 *    you" three times. A backlog is SUPERSEDED, not replayed: a workspace that turns out to be 70
 *    days past its trial when the programme is switched on gets the 60-day message once, and the
 *    30-day one is recorded as superseded.
 *
 * 2. DELETION NEEDS EVERY REASON TO EXIST AND NO REASON NOT TO. The window has passed, the final
 *    notice was actually sent — on a PREVIOUS tick, so the customer had a day with it — nobody has
 *    paid, nobody has restored, nobody has held it, and the kill switch is on. Any one of those
 *    missing is a named reason in the queue, never a silent skip. A manual delete from the console
 *    skips the timing but never the "nobody has paid" check.
 *
 * 3. THE SCHEDULE IS PURE. `retentionPlan()` takes an org row, the settings and a clock and returns
 *    what is due and why — no I/O — so the console's dry run, the worker's real tick and the tests
 *    all ask the same function and cannot disagree.
 */
import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient as ControlPrismaClient } from "../generated/control-client/index.js";
import { controlPrisma } from "../config/control-prisma.js";
import { env } from "../config/env.js";
import { disconnectAllTenantClients, prisma } from "../config/prisma.js";
import { withOrgTenant } from "../config/with-org-tenant.js";
import { AppError } from "../middleware/error.js";
import { decryptSecret } from "../utils/encryption.js";
import { forgetOrgStatus } from "./org-status.service.js";
import { platformAudit } from "./platform-audit.service.js";
import { RETENTION_MARKER_TEMPLATE } from "./platform-mail-templates.js";
import { sendPlatformTemplate } from "./platform-mail.service.js";
import { workspaceUrlForSlug } from "./workspace-directory.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const appBase = () => env.APP_BASE_URL.replace(/\/$/, "");

/* ------------------------------------------------------------------------------------------ */
/* Settings                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface RetentionSettings {
  enabled: boolean;
  feedbackDay: number;
  reminderDays: number[];
  retentionDays: number;
  autoDeleteEnabled: boolean;
  snapshotDir: string | null;
  updatedAt: Date | null;
}

export const DEFAULT_RETENTION_SETTINGS: RetentionSettings = {
  enabled: true,
  feedbackDay: 10,
  reminderDays: [30, 60, 80, 90],
  retentionDays: 90,
  autoDeleteEnabled: true,
  snapshotDir: null,
  updatedAt: null
};

function normaliseReminderDays(raw: unknown): number[] {
  const days = Array.isArray(raw) ? raw.filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d > 0) : [];
  return [...new Set(days)].sort((a, b) => a - b);
}

function toSettings(row: { enabled: boolean; feedbackDay: number; reminderDays: unknown; retentionDays: number; autoDeleteEnabled: boolean; snapshotDir: string | null; updatedAt: Date }): RetentionSettings {
  const reminderDays = normaliseReminderDays(row.reminderDays);
  return {
    enabled: row.enabled,
    feedbackDay: row.feedbackDay,
    reminderDays: reminderDays.length ? reminderDays : DEFAULT_RETENTION_SETTINGS.reminderDays,
    retentionDays: row.retentionDays,
    autoDeleteEnabled: row.autoDeleteEnabled,
    snapshotDir: row.snapshotDir,
    updatedAt: row.updatedAt
  };
}

/** Created on first read with the documented defaults — the policy is visible in the console, not hidden in a migration. */
export async function getRetentionSettings(): Promise<RetentionSettings> {
  const existing = await controlPrisma.platformRetentionSettings.findUnique({ where: { id: "global" } });
  if (existing) return toSettings(existing);
  const created = await controlPrisma.platformRetentionSettings.create({
    data: {
      id: "global",
      enabled: DEFAULT_RETENTION_SETTINGS.enabled,
      feedbackDay: DEFAULT_RETENTION_SETTINGS.feedbackDay,
      reminderDays: DEFAULT_RETENTION_SETTINGS.reminderDays,
      retentionDays: DEFAULT_RETENTION_SETTINGS.retentionDays,
      autoDeleteEnabled: DEFAULT_RETENTION_SETTINGS.autoDeleteEnabled
    }
  });
  return toSettings(created);
}

/** Never throws: the trial-lifecycle worker asks this to decide who sends "trial ended", and a
 *  control-plane hiccup must fall back to the tenant path, not to no email at all. */
export async function isRetentionProgrammeEnabled(): Promise<boolean> {
  try {
    return (await getRetentionSettings()).enabled;
  } catch {
    return false;
  }
}

export async function updateRetentionSettings(patch: Partial<Omit<RetentionSettings, "updatedAt">>, actorLabel: string): Promise<RetentionSettings> {
  const current = await getRetentionSettings();
  const next = { ...current, ...patch };
  const reminderDays = normaliseReminderDays(next.reminderDays);
  if (!reminderDays.length) throw new AppError(422, "At least one reminder day is required.");
  // The last reminder IS the final notice, so it cannot land after the deletion it warns about.
  if (reminderDays[reminderDays.length - 1] > next.retentionDays) {
    throw new AppError(422, `The last reminder (day ${reminderDays[reminderDays.length - 1]}) must not be after the retention window (${next.retentionDays} days).`);
  }
  const row = await controlPrisma.platformRetentionSettings.update({
    where: { id: "global" },
    data: { enabled: next.enabled, feedbackDay: next.feedbackDay, reminderDays, retentionDays: next.retentionDays, autoDeleteEnabled: next.autoDeleteEnabled, snapshotDir: next.snapshotDir?.trim() || null }
  });
  await platformAudit("PLATFORM_ADMIN", actorLabel, "retention.settings_updated", "PlatformRetentionSettings", "global", { ...patch });
  return toSettings(row);
}

/* ------------------------------------------------------------------------------------------ */
/* The schedule — pure                                                                          */
/* ------------------------------------------------------------------------------------------ */

export interface RetentionOrgInput {
  id: string;
  name: string;
  slug: string;
  status: "PROVISIONING" | "ACTIVE" | "GRACE" | "SUSPENDED" | "ARCHIVED";
  planTier: "STARTER" | "TEAM" | "ENTERPRISE";
  trialTier: "STARTER" | "TEAM" | "ENTERPRISE" | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  stripeSubscriptionId: string | null;
  retentionNoticesSent: unknown;
  retentionHold: boolean;
  retentionDeletedAt: Date | null;
  createdAt: Date;
}

export type DeletionBlocker =
  | "not-in-programme"
  | "converted"
  | "status"
  | "not-yet"
  | "hold"
  | "auto-delete-off"
  | "final-notice-pending"
  | "final-notice-today";

export interface RetentionPlan {
  inProgramme: boolean;
  converted: boolean;
  stage: "none" | "trial" | "lapsed" | "converted" | "deleted";
  daysIntoTrial: number | null;
  daysSinceTrialEnd: number | null;
  deleteAt: Date | null;
  daysUntilDeletion: number | null;
  /** marker → ISO timestamp, or "superseded". */
  sent: Record<string, string>;
  /** Markers to send on this tick, in order. */
  due: string[];
  /** Markers whose moment passed unsent and which are recorded rather than replayed. */
  superseded: string[];
  finalMarker: string;
  nextMarker: { marker: string; at: Date } | null;
  deletionDue: boolean;
  deletionBlockedBy: DeletionBlocker | null;
}

/** How long a final notice must have been out before the deletion runs. A tick is 24h apart, so
 *  "sent on a previous tick" is what this encodes, with slack for a tick that ran a little early. */
const FINAL_NOTICE_LEAD_MS = 20 * 60 * 60 * 1000;
/** A "your trial has ended" message older than this is no longer news; it is recorded as superseded. */
const ENDED_MESSAGE_WINDOW_DAYS = 7;

export function noticesSent(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}

export function isConverted(org: Pick<RetentionOrgInput, "trialTier" | "stripeSubscriptionId" | "planTier">): boolean {
  // The Stripe webhook nulls `trialTier` when a checkout completes; a platform admin converting a
  // customer by hand raises `planTier`. Either is "somebody is paying" — and a paying customer is
  // never in this programme, whatever the clock says.
  return org.trialTier === null || Boolean(org.stripeSubscriptionId) || org.planTier !== "STARTER";
}

export function retentionPlan(org: RetentionOrgInput, settings: RetentionSettings, now: Date): RetentionPlan {
  const sent = noticesSent(org.retentionNoticesSent);
  const reminderDays = settings.reminderDays;
  const finalMarker = String(reminderDays[reminderDays.length - 1]);
  const base: RetentionPlan = {
    inProgramme: false,
    converted: false,
    stage: "none",
    daysIntoTrial: null,
    daysSinceTrialEnd: null,
    deleteAt: null,
    daysUntilDeletion: null,
    sent,
    due: [],
    superseded: [],
    finalMarker,
    nextMarker: null,
    deletionDue: false,
    deletionBlockedBy: "not-in-programme"
  };

  if (org.retentionDeletedAt) return { ...base, stage: "deleted" };
  if (!org.trialEndsAt || org.status === "ARCHIVED" || org.status === "PROVISIONING") return base;

  const converted = isConverted(org);
  const trialStart = org.trialStartedAt ?? org.createdAt;
  const daysIntoTrial = Math.floor((now.getTime() - trialStart.getTime()) / DAY_MS);
  const daysSinceTrialEnd = Math.floor((now.getTime() - org.trialEndsAt.getTime()) / DAY_MS);
  const deleteAt = new Date(org.trialEndsAt.getTime() + settings.retentionDays * DAY_MS);
  const daysUntilDeletion = Math.ceil((deleteAt.getTime() - now.getTime()) / DAY_MS);
  const inTrial = now < org.trialEndsAt && org.status === "ACTIVE";
  const lapsed = org.status === "GRACE" || org.status === "SUSPENDED";

  const plan: RetentionPlan = {
    ...base,
    inProgramme: true,
    converted,
    stage: converted ? "converted" : inTrial ? "trial" : "lapsed",
    daysIntoTrial,
    daysSinceTrialEnd,
    deleteAt,
    daysUntilDeletion,
    deletionBlockedBy: null
  };

  if (converted) return { ...plan, deletionBlockedBy: "converted" };

  // ── What is due ─────────────────────────────────────────────────────────────────────────────
  if (inTrial && daysIntoTrial >= settings.feedbackDay && !sent.feedback10) plan.due.push("feedback10");

  if (lapsed && daysSinceTrialEnd >= 0) {
    if (!sent.ended) {
      if (daysSinceTrialEnd <= ENDED_MESSAGE_WINDOW_DAYS) plan.due.push("ended");
      else plan.superseded.push("ended");
    }
    const overdue = reminderDays.filter((d) => daysSinceTrialEnd >= d && !sent[String(d)]);
    if (overdue.length) {
      // Only the latest overdue reminder is news. Earlier ones are recorded, never replayed.
      const latest = overdue[overdue.length - 1];
      plan.due.push(String(latest));
      for (const d of overdue.slice(0, -1)) plan.superseded.push(String(d));
    }
  }

  // ── What comes next ─────────────────────────────────────────────────────────────────────────
  if (inTrial && !sent.feedback10 && daysIntoTrial < settings.feedbackDay) {
    plan.nextMarker = { marker: "feedback10", at: new Date(trialStart.getTime() + settings.feedbackDay * DAY_MS) };
  } else if (!inTrial || now >= org.trialEndsAt) {
    const upcoming = reminderDays.find((d) => daysSinceTrialEnd < d && !sent[String(d)]);
    if (upcoming !== undefined) plan.nextMarker = { marker: String(upcoming), at: new Date(org.trialEndsAt.getTime() + upcoming * DAY_MS) };
  } else {
    plan.nextMarker = { marker: "ended", at: org.trialEndsAt };
  }

  // ── Deletion ────────────────────────────────────────────────────────────────────────────────
  if (!lapsed) plan.deletionBlockedBy = "status";
  else if (daysSinceTrialEnd < settings.retentionDays) plan.deletionBlockedBy = "not-yet";
  else if (org.retentionHold) plan.deletionBlockedBy = "hold";
  else if (!settings.autoDeleteEnabled) plan.deletionBlockedBy = "auto-delete-off";
  else if (!sent[finalMarker] || sent[finalMarker] === "superseded") plan.deletionBlockedBy = "final-notice-pending";
  else if (now.getTime() - new Date(sent[finalMarker]).getTime() < FINAL_NOTICE_LEAD_MS) plan.deletionBlockedBy = "final-notice-today";
  else plan.deletionDue = true;

  return plan;
}

/* ------------------------------------------------------------------------------------------ */
/* Public tokens                                                                                */
/* ------------------------------------------------------------------------------------------ */

export type PublicTokenPurpose = "feedback" | "reactivate";
interface PublicTokenPayload {
  o: string;
  p: PublicTokenPurpose;
  s?: string;
  e: number;
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const sign = (body: string) => createHmac("sha256", env.JWT_ACCESS_SECRET).update(body).digest("hex").slice(0, 40);

export function signPublicToken(payload: PublicTokenPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${sign(body)}`;
}

export function verifyPublicToken(token: string, purpose: PublicTokenPurpose, now = Date.now()): PublicTokenPayload | null {
  const [body, mac] = token.split(".");
  if (!body || !mac || mac.length !== 40) return null;
  const expected = sign(body);
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString("utf8")) as PublicTokenPayload;
    if (payload.p !== purpose || typeof payload.o !== "string" || typeof payload.e !== "number") return null;
    if (payload.e <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Recipients and variables                                                                    */
/* ------------------------------------------------------------------------------------------ */

type OrgRow = NonNullable<Awaited<ReturnType<typeof loadOrg>>>;

async function loadOrg(orgId: string) {
  return controlPrisma.organization.findUnique({
    where: { id: orgId },
    include: { database: { select: { encryptedDsn: true, host: true, databaseName: true } } }
  });
}

function firstName(nameOrEmail: string): string {
  const local = nameOrEmail.includes("@") ? nameOrEmail.split("@")[0] : nameOrEmail;
  const word = local.split(/[\s._-]+/)[0] ?? "there";
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : "there";
}

/** Who the programme writes to. The address recorded at signup first; a still-reachable
 *  workspace's super admin as the fallback for orgs that predate the column. */
async function recipientFor(org: OrgRow): Promise<{ to: string; name: string } | null> {
  let tenantAdmin: { email: string; name: string } | null = null;
  if (org.status === "ACTIVE" || org.status === "GRACE") {
    try {
      tenantAdmin = await withOrgTenant(org.slug, async () => {
        const admin = await prisma.user.findFirst({
          where: { status: "ACTIVE", deletedAt: null, isAgent: false, role: { name: "SUPER_ADMIN" } },
          orderBy: { createdAt: "asc" },
          select: { email: true, name: true }
        });
        return admin ?? null;
      });
    } catch {
      tenantAdmin = null;
    }
  }
  if (org.ownerEmail) return { to: org.ownerEmail, name: tenantAdmin?.email === org.ownerEmail ? firstName(tenantAdmin.name) : firstName(org.ownerEmail) };
  if (tenantAdmin) return { to: tenantAdmin.email, name: firstName(tenantAdmin.name) };
  return null;
}

const longDate = (d: Date | null) => (d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "");

export function retentionVars(org: { id: string; name: string; slug: string; trialEndsAt: Date | null }, plan: RetentionPlan, settings: RetentionSettings, marker: string, name: string, now: Date) {
  const workspaceUrl = workspaceUrlForSlug(org.slug);
  const expiry = (plan.deleteAt ?? new Date(now.getTime() + 120 * DAY_MS)).getTime();
  const feedbackToken = signPublicToken({ o: org.id, p: "feedback", s: marker, e: expiry + 30 * DAY_MS });
  const reactivateToken = signPublicToken({ o: org.id, p: "reactivate", s: marker, e: Math.max(expiry, now.getTime() + DAY_MS) });
  const daysLeft = org.trialEndsAt ? Math.max(0, Math.ceil((org.trialEndsAt.getTime() - now.getTime()) / DAY_MS)) : 0;
  return {
    name,
    workspace: org.name,
    workspaceUrl,
    reactivateUrl: `${appBase()}/reactivate/${reactivateToken}`,
    feedbackUrl: `${appBase()}/feedback/${feedbackToken}`,
    billingUrl: `${workspaceUrl}/app/settings?tab=billing`,
    signupUrl: `${appBase()}/signup`,
    deleteDate: longDate(plan.deleteAt),
    daysUntilDeletion: String(Math.max(0, plan.daysUntilDeletion ?? 0)),
    daysSinceTrial: String(Math.max(0, plan.daysSinceTrialEnd ?? 0)),
    retentionDays: String(settings.retentionDays),
    daysLeft: String(daysLeft)
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Sending                                                                                     */
/* ------------------------------------------------------------------------------------------ */

async function recordMarkers(orgId: string, current: unknown, updates: Record<string, string>) {
  await controlPrisma.organization.update({ where: { id: orgId }, data: { retentionNoticesSent: { ...noticesSent(current), ...updates } } });
}

export interface RetentionSendResult {
  ok: boolean;
  status: "SENT" | "FAILED" | "SKIPPED";
  marker: string;
  to: string | null;
  subject?: string;
  errorMessage?: string;
}

export async function sendRetentionMarker(orgId: string, marker: string, opts: { actorLabel: string; force?: boolean; now?: Date }): Promise<RetentionSendResult> {
  const templateKey = RETENTION_MARKER_TEMPLATE[marker];
  if (!templateKey) throw new AppError(404, "Unknown retention stage");
  const org = await loadOrg(orgId);
  if (!org) throw new AppError(404, "Organization not found");
  const now = opts.now ?? new Date();
  const settings = await getRetentionSettings();
  const plan = retentionPlan(org, settings, now);
  if (!plan.inProgramme) throw new AppError(409, `"${org.slug}" was never a trial workspace, so the retention programme has nothing to send it.`);
  if (plan.converted && !opts.force) throw new AppError(409, `"${org.slug}" is a paying customer — the programme does not write to them.`);

  const recipient = await recipientFor(org);
  if (!recipient) {
    const message = "No recipient: the workspace has no recorded owner email and its super admins are unreachable.";
    await controlPrisma.platformEmailLog.create({
      data: { organizationId: org.id, templateKey, to: "(none)", subject: templateKey, status: "SKIPPED", errorMessage: message, dayMarker: marker, metadata: { by: opts.actorLabel } }
    });
    await recordMarkers(org.id, org.retentionNoticesSent, { [marker]: now.toISOString() });
    return { ok: false, status: "SKIPPED", marker, to: null, errorMessage: message };
  }

  const result = await sendPlatformTemplate(templateKey, {
    to: recipient.to,
    vars: retentionVars(org, plan, settings, marker, recipient.name, now),
    organizationId: org.id,
    dayMarker: marker,
    metadata: { by: opts.actorLabel, forced: Boolean(opts.force) }
  });
  // Recorded even when it failed — the same rule the trial worker follows, for the same reason.
  await recordMarkers(org.id, org.retentionNoticesSent, { [marker]: now.toISOString() });
  return { ok: result.ok, status: result.status, marker, to: recipient.to, subject: result.subject, errorMessage: result.errorMessage };
}

export async function setRetentionHold(orgId: string, hold: boolean, actorLabel: string) {
  const org = await controlPrisma.organization.update({ where: { id: orgId }, data: { retentionHold: hold }, select: { id: true, slug: true, retentionHold: true } }).catch(() => null);
  if (!org) throw new AppError(404, "Organization not found");
  await platformAudit("PLATFORM_ADMIN", actorLabel, hold ? "retention.hold_set" : "retention.hold_released", "Organization", org.id, { slug: org.slug });
  return org;
}

/* ------------------------------------------------------------------------------------------ */
/* Deletion                                                                                    */
/* ------------------------------------------------------------------------------------------ */

const SAFE_DB_NAME = /^\w{1,64}$/;

interface SnapshotResult {
  taken: boolean;
  path?: string;
  reason?: string;
}

/** Best-effort `mysqldump` before the drop. Never throws: a missing binary is a recorded fact, not
 *  a reason to leave a workspace the policy said would be deleted sitting there forever. */
async function snapshotDatabase(dsn: string, databaseName: string, dir: string | null, slug: string): Promise<SnapshotResult> {
  if (!dir) return { taken: false, reason: "snapshots are disabled (no snapshot directory set)" };
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return { taken: false, reason: "the tenant DSN could not be parsed" };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { taken: false, reason: `could not create ${dir}: ${(error as Error).message}` };
  }
  const file = path.join(dir, `${slug}-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`);
  const binary = process.env.MYSQLDUMP_PATH || "mysqldump";
  return new Promise<SnapshotResult>((resolve) => {
    const out = fs.createWriteStream(file);
    const child = spawn(
      binary,
      ["--host", url.hostname, "--port", url.port || "3306", "--user", decodeURIComponent(url.username), "--single-transaction", "--routines", "--triggers", databaseName],
      // The password travels in the environment, never on the command line where `ps` can read it.
      { env: { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) }, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    child.stdout.pipe(out);
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      out.close();
      fs.rmSync(file, { force: true });
      resolve({ taken: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? `${binary} was not found (set MYSQLDUMP_PATH)` : error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      out.close();
      if (code === 0) resolve({ taken: true, path: file });
      else {
        fs.rmSync(file, { force: true });
        resolve({ taken: false, reason: `mysqldump exited ${code}: ${stderr.trim().slice(0, 300)}` });
      }
    });
  });
}

async function dropPhysicalDatabase(dsn: string, databaseName: string): Promise<void> {
  if (!SAFE_DB_NAME.test(databaseName)) throw new AppError(500, `Refusing to drop a database with an unexpected name: ${databaseName}`);
  // The provisioning credentials if there are any (they created it), else the tenant's own DSN.
  const url = new URL(env.TENANT_DB_PROVISION_BASE_URL || dsn);
  url.pathname = "/mysql";
  const scratch = new ControlPrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    await scratch.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${databaseName}\``);
  } finally {
    await scratch.$disconnect();
  }
}

export interface DeletionResult {
  deleted: boolean;
  dryRun?: boolean;
  blockedBy?: DeletionBlocker | null;
  databaseName?: string | null;
  snapshot?: SnapshotResult;
  confirmationSent?: boolean;
}

export async function deleteWorkspaceUnderPolicy(orgId: string, opts: { actorLabel: string; dryRun?: boolean; force?: boolean; now?: Date }): Promise<DeletionResult> {
  const org = await loadOrg(orgId);
  if (!org) throw new AppError(404, "Organization not found");
  const now = opts.now ?? new Date();
  const settings = await getRetentionSettings();
  const plan = retentionPlan(org, settings, now);

  if (opts.force) {
    // The timing can be overridden by a person. "Nobody is paying" cannot.
    if (!plan.inProgramme) throw new AppError(409, `"${org.slug}" was never a trial workspace — this is not the way to delete it.`);
    if (plan.converted) throw new AppError(409, `"${org.slug}" is a paying customer. The retention policy never deletes a paying customer.`);
    if (org.status !== "GRACE" && org.status !== "SUSPENDED") throw new AppError(409, `"${org.slug}" is ${org.status.toLowerCase()} — only a lapsed workspace can be deleted under the policy.`);
  } else if (!plan.deletionDue) {
    return { deleted: false, blockedBy: plan.deletionBlockedBy, databaseName: org.database?.databaseName ?? null };
  }

  if (opts.dryRun) return { deleted: false, dryRun: true, blockedBy: null, databaseName: org.database?.databaseName ?? null };

  let snapshot: SnapshotResult = { taken: false, reason: "no database registered" };
  if (org.database) {
    const dsn = decryptSecret(org.database.encryptedDsn);
    snapshot = await snapshotDatabase(dsn, org.database.databaseName, settings.snapshotDir, org.slug);
    await dropPhysicalDatabase(dsn, org.database.databaseName);
    // The cached client for the dropped database would keep a dead pool open; the others reconnect lazily.
    await disconnectAllTenantClients().catch(() => undefined);
  }

  await controlPrisma.$transaction([
    controlPrisma.orgDatabase.deleteMany({ where: { organizationId: org.id } }),
    // The finder must stop listing it, and a custom domain must stop pointing at nothing.
    controlPrisma.orgUserDirectory.deleteMany({ where: { organizationId: org.id } }),
    controlPrisma.orgDomain.deleteMany({ where: { organizationId: org.id } }),
    controlPrisma.orgSsoConfig.deleteMany({ where: { organizationId: org.id } }),
    controlPrisma.organization.update({
      where: { id: org.id },
      data: { status: "ARCHIVED", retentionDeletedAt: now, suspendedAt: now, suspendedReason: `Deleted under the ${settings.retentionDays}-day trial retention policy.`, retentionHold: false }
    })
  ]);
  forgetOrgStatus(org.id);
  await platformAudit(opts.force ? "PLATFORM_ADMIN" : "SYSTEM", opts.actorLabel, "retention.workspace_deleted", "Organization", org.id, {
    slug: org.slug,
    databaseName: org.database?.databaseName ?? null,
    snapshot,
    forced: Boolean(opts.force)
  });

  let confirmationSent = false;
  if (org.ownerEmail) {
    const feedbackToken = signPublicToken({ o: org.id, p: "feedback", s: "deleted", e: now.getTime() + 60 * DAY_MS });
    const result = await sendPlatformTemplate("retention.deleted", {
      to: org.ownerEmail,
      vars: { name: firstName(org.ownerEmail), workspace: org.name, signupUrl: `${appBase()}/signup`, feedbackUrl: `${appBase()}/feedback/${feedbackToken}` },
      organizationId: org.id,
      dayMarker: "deleted",
      metadata: { by: opts.actorLabel }
    });
    confirmationSent = result.ok;
  }
  return { deleted: true, databaseName: org.database?.databaseName ?? null, snapshot, confirmationSent };
}

/* ------------------------------------------------------------------------------------------ */
/* The queue and the tick                                                                      */
/* ------------------------------------------------------------------------------------------ */

export async function getRetentionQueue(now = new Date()) {
  const settings = await getRetentionSettings();
  const orgs = await controlPrisma.organization.findMany({
    where: { trialEndsAt: { not: null } },
    orderBy: { trialEndsAt: "asc" },
    include: { _count: { select: { feedback: true } } }
  });
  const lastEmails = orgs.length
    ? await controlPrisma.platformEmailLog.findMany({
        where: { organizationId: { in: orgs.map((o) => o.id) }, isTest: false },
        orderBy: { createdAt: "desc" },
        distinct: ["organizationId"],
        select: { organizationId: true, templateKey: true, status: true, createdAt: true, dayMarker: true }
      })
    : [];
  const lastByOrg = new Map(lastEmails.map((e) => [e.organizationId, e]));
  return orgs.map((org) => ({
    id: org.id,
    name: org.name,
    slug: org.slug,
    status: org.status,
    planTier: org.planTier,
    trialTier: org.trialTier,
    ownerEmail: org.ownerEmail,
    trialStartedAt: org.trialStartedAt,
    trialEndsAt: org.trialEndsAt,
    retentionHold: org.retentionHold,
    retentionDeletedAt: org.retentionDeletedAt,
    feedbackCount: org._count.feedback,
    lastEmail: lastByOrg.get(org.id) ?? null,
    plan: retentionPlan(org, settings, now)
  }));
}

export interface RetentionTickResult {
  enabled: boolean;
  dryRun: boolean;
  now: string;
  sent: Array<{ org: string; marker: string; to: string | null }>;
  failed: Array<{ org: string; marker: string; error: string }>;
  superseded: Array<{ org: string; marker: string }>;
  deleted: Array<{ org: string; databaseName: string | null; snapshot?: SnapshotResult }>;
  held: Array<{ org: string; blockedBy: DeletionBlocker | null }>;
  wouldSend: Array<{ org: string; marker: string }>;
  wouldDelete: Array<{ org: string }>;
}

export async function runRetentionTick(now = new Date(), opts: { dryRun?: boolean; actorLabel?: string } = {}): Promise<RetentionTickResult> {
  const dryRun = Boolean(opts.dryRun);
  const actorLabel = opts.actorLabel ?? "scheduler";
  const result: RetentionTickResult = { enabled: true, dryRun, now: now.toISOString(), sent: [], failed: [], superseded: [], deleted: [], held: [], wouldSend: [], wouldDelete: [] };
  const settings = await getRetentionSettings();
  if (!settings.enabled) return { ...result, enabled: false };

  const orgs = await controlPrisma.organization.findMany({
    where: { trialEndsAt: { not: null }, retentionDeletedAt: null, status: { in: ["ACTIVE", "GRACE", "SUSPENDED"] } }
  });

  for (const org of orgs) {
    const plan = retentionPlan(org, settings, now);
    if (!plan.inProgramme || plan.converted) continue;

    if (plan.superseded.length) {
      result.superseded.push(...plan.superseded.map((marker) => ({ org: org.slug, marker })));
      if (!dryRun) await recordMarkers(org.id, org.retentionNoticesSent, Object.fromEntries(plan.superseded.map((m) => [m, "superseded"])));
    }

    for (const marker of plan.due) {
      if (dryRun) {
        result.wouldSend.push({ org: org.slug, marker });
        continue;
      }
      try {
        const sent = await sendRetentionMarker(org.id, marker, { actorLabel, now });
        if (sent.ok) result.sent.push({ org: org.slug, marker, to: sent.to });
        else result.failed.push({ org: org.slug, marker, error: sent.errorMessage ?? sent.status });
      } catch (error) {
        // One workspace's failure must not stop the tick for the ones after it.
        result.failed.push({ org: org.slug, marker, error: (error as Error).message });
      }
    }

    if (plan.deletionDue) {
      if (dryRun) {
        result.wouldDelete.push({ org: org.slug });
        continue;
      }
      try {
        const deletion = await deleteWorkspaceUnderPolicy(org.id, { actorLabel, now });
        if (deletion.deleted) result.deleted.push({ org: org.slug, databaseName: deletion.databaseName ?? null, snapshot: deletion.snapshot });
        else result.held.push({ org: org.slug, blockedBy: deletion.blockedBy ?? null });
      } catch (error) {
        result.failed.push({ org: org.slug, marker: "delete", error: (error as Error).message });
      }
    } else if (plan.deletionBlockedBy === "hold" || plan.deletionBlockedBy === "auto-delete-off") {
      result.held.push({ org: org.slug, blockedBy: plan.deletionBlockedBy });
    }
  }
  return result;
}

/* ------------------------------------------------------------------------------------------ */
/* The customer's doors: feedback and reactivation                                             */
/* ------------------------------------------------------------------------------------------ */

const notFound = () => new AppError(404, "This link isn't valid any more.");

export async function describeFeedbackToken(token: string) {
  const payload = verifyPublicToken(token, "feedback");
  if (!payload) throw notFound();
  const org = await controlPrisma.organization.findUnique({ where: { id: payload.o }, select: { id: true, name: true } });
  if (!org) throw notFound();
  const stage = payload.s ?? "unknown";
  const already = await controlPrisma.trialFeedback.count({ where: { organizationId: org.id, stage } });
  return { workspace: org.name, stage, alreadySubmitted: already > 0 };
}

export async function submitTrialFeedback(token: string, body: { rating: number; liked?: string; missing?: string; wouldReturn?: string; comment?: string }) {
  const payload = verifyPublicToken(token, "feedback");
  if (!payload) throw notFound();
  const org = await controlPrisma.organization.findUnique({ where: { id: payload.o }, select: { id: true, slug: true } });
  if (!org) throw notFound();
  const stage = payload.s ?? "unknown";
  const row = await controlPrisma.trialFeedback.create({
    data: { organizationId: org.id, stage, rating: body.rating, liked: body.liked?.trim() || null, missing: body.missing?.trim() || null, wouldReturn: body.wouldReturn ?? null, comment: body.comment?.trim() || null }
  });
  await platformAudit("CUSTOMER", org.slug, "retention.feedback_received", "Organization", org.id, { stage, rating: body.rating, wouldReturn: body.wouldReturn ?? null });
  return { ok: true, id: row.id };
}

export async function describeReactivateToken(token: string) {
  const payload = verifyPublicToken(token, "reactivate");
  if (!payload) throw notFound();
  const org = await controlPrisma.organization.findUnique({ where: { id: payload.o } });
  if (!org || org.retentionDeletedAt) throw notFound();
  const settings = await getRetentionSettings();
  const plan = retentionPlan(org, settings, new Date());
  return {
    workspace: org.name,
    slug: org.slug,
    url: workspaceUrlForSlug(org.slug),
    status: org.status,
    alreadyActive: org.status === "ACTIVE" || plan.converted,
    eligible: (org.status === "GRACE" || org.status === "SUSPENDED") && !plan.converted,
    deleteDate: plan.deleteAt ? plan.deleteAt.toISOString() : null
  };
}

export async function reactivateWorkspace(token: string) {
  const payload = verifyPublicToken(token, "reactivate");
  if (!payload) throw notFound();
  const org = await controlPrisma.organization.findUnique({ where: { id: payload.o } });
  if (!org || org.retentionDeletedAt) throw notFound();
  const url = workspaceUrlForSlug(org.slug);
  const settings = await getRetentionSettings();
  const plan = retentionPlan(org, settings, new Date());
  if (org.status === "ACTIVE" || plan.converted) return { restored: false, alreadyActive: true, url: `${url}/login` };
  if (org.status !== "GRACE" && org.status !== "SUSPENDED") throw notFound();

  // Back to GRACE with a fresh window: the door is open again, billing is reachable, and nothing
  // else is. The retention clock is HELD rather than reset — a person showed intent, and the queue
  // shows a platform admin exactly that, so the decision to release the hold is a visible one.
  await controlPrisma.organization.update({
    where: { id: org.id },
    data: { status: "GRACE", graceStartedAt: new Date(), suspendedAt: null, suspendedReason: "Restored by the owner from a retention email — awaiting a plan.", retentionHold: true }
  });
  forgetOrgStatus(org.id);
  await platformAudit("CUSTOMER", org.slug, "retention.workspace_restored", "Organization", org.id, { fromStatus: org.status, stage: payload.s ?? null });
  return { restored: true, alreadyActive: false, url: `${url}/login?returnTo=${encodeURIComponent("/app/settings?tab=billing")}` };
}
