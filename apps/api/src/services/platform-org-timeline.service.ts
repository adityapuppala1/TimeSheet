/**
 * WHAT: one workspace's incident timeline — everything that happened TO it or ON it, in one
 * chronological read.
 *
 * WHY IT EXISTS. The Org 360 page already showed five panels: the audit trail, the backup runs, the
 * platform email log, the database series, the advisories. Each is correct and each is a different
 * list, so answering the question a support call actually opens with — "when did this start?" —
 * meant reading five lists side by side and merging them by eye, in your head, under time pressure.
 * The merge is mechanical. Doing it here means the answer is one screen and one scroll.
 *
 * IT COMPOSES, IT DOES NOT MEASURE. Every row below already exists in the control plane; nothing
 * here computes a new fact, opens a tenant database, or has an opinion. That is deliberate: a
 * second implementation of "what happened to Acme" that disagrees with the panels above it would be
 * worse than the five lists were.
 *
 * WHAT IT NEVER SHOWS. The same line every cross-tenant surface in this console holds: statuses,
 * counts, sizes, timestamps and the platform's OWN actions. No ticket, no comment, no timesheet,
 * nobody's name from inside the workspace. The one apparent exception is inherited rather than new
 * — the platform email log holds addresses THIS platform sent to, which is our correspondence and
 * not the customer's.
 *
 * THE ALERT ROWS ARE THE INTERESTING HALF. `PlatformAlertState.firstSeenAt` is the moment a
 * condition began and `resolvedAt` the moment it ended, so a single database row becomes two
 * bookends on the timeline — which is the entire reason that table keeps resolved rows instead of
 * deleting them.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { AppError } from "../middleware/error.js";

export type TimelineKind = "alert" | "alert-cleared" | "backup" | "operator" | "maintenance" | "email";

export interface TimelineEntry {
  at: string;
  kind: TimelineKind;
  /** Reuses the alert vocabulary so one legend covers the whole page. "info" is the neutral tone. */
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  /** Who or what did it. Null for a condition nothing chose, like a database filling up. */
  actor: string | null;
}

/** How far back, and how many rows. Bounded because this is a page, not an export: a workspace with
 *  two years of hourly alerts would otherwise stream a megabyte into a panel showing twenty rows. */
const DEFAULT_DAYS = 90;
const MAX_ENTRIES = 200;

export async function getOrgTimeline(orgId: string, days = DEFAULT_DAYS): Promise<{ entries: TimelineEntry[]; since: string; truncated: boolean }> {
  const org = await controlPrisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true } });
  if (!org) throw new AppError(404, "Organization not found");

  const since = new Date(Date.now() - days * 86_400_000);
  const window = { gte: since };

  const [audit, backups, alerts, broadcasts, emails] = await Promise.all([
    controlPrisma.platformAuditLog.findMany({
      where: { entityId: orgId, createdAt: window },
      orderBy: { createdAt: "desc" },
      take: MAX_ENTRIES
    }),
    controlPrisma.backupRun.findMany({ where: { organizationId: orgId, startedAt: window }, orderBy: { startedAt: "desc" }, take: MAX_ENTRIES }),
    controlPrisma.platformAlertState.findMany({ where: { organizationId: orgId, lastSeenAt: window }, orderBy: { lastSeenAt: "desc" }, take: MAX_ENTRIES }),
    // Broadcasts are fleet-wide rows; which workspaces they reached lives in `outcomes`, so the
    // filtering happens below rather than in SQL. Bounded hard for that reason.
    controlPrisma.platformMaintenanceBroadcast.findMany({ where: { createdAt: window }, orderBy: { createdAt: "desc" }, take: 100 }),
    // FAILED only. A timeline is a record of things that went wrong or were done on purpose; a
    // successful retention email is neither, and including every send would bury both.
    controlPrisma.platformEmailLog.findMany({
      where: { organizationId: orgId, createdAt: window, status: { in: ["FAILED", "SKIPPED"] } },
      orderBy: { createdAt: "desc" },
      take: MAX_ENTRIES
    })
  ]);

  // One mapper per source, so adding a sixth source is a function rather than another branch in an
  // already-long one — and so each source's own quirks (a broadcast's per-workspace outcome, an
  // alert becoming two entries) stay next to the rows they come from.
  const entries: TimelineEntry[] = [
    ...audit.map(auditEntry),
    ...backups.map(backupEntry),
    ...alerts.flatMap(alertEntries),
    ...broadcasts.map((broadcast) => broadcastEntry(broadcast, orgId)).filter((entry): entry is TimelineEntry => entry !== null),
    ...emails.map(emailEntry)
  ];

  entries.sort((a, b) => b.at.localeCompare(a.at));
  return { entries: entries.slice(0, MAX_ENTRIES), since: since.toISOString(), truncated: entries.length > MAX_ENTRIES };
}

/* ------------------------------------------------------------------------------------------ */
/* One mapper per source                                                                       */
/* ------------------------------------------------------------------------------------------ */

type AuditRow = { createdAt: Date; action: string; reason: string | null; actorLabel: string | null; actorType: string };
type BackupRow = { startedAt: Date; status: string; kind: string; finishedAt: Date | null; errorMessage: string | null };
type AlertRow = { firstSeenAt: Date; resolvedAt: Date | null; severity: string; title: string; detail: string };
type BroadcastRow = { createdAt: Date; enabled: boolean; message: string | null; actorLabel: string; outcomes: unknown };
type EmailRow = { createdAt: Date; status: string; templateKey: string; errorMessage: string | null };

const auditEntry = (row: AuditRow): TimelineEntry => ({
  at: row.createdAt.toISOString(),
  kind: "operator",
  severity: "info",
  // The REASON, when the operator was made to give one. It is the single most useful sentence on
  // this page six months later, and the column exists precisely so it survives.
  title: row.action,
  detail: row.reason ?? "",
  actor: row.actorLabel ?? row.actorType
});

const backupEntry = (run: BackupRow): TimelineEntry => {
  const finished = run.finishedAt ? `, finished ${run.finishedAt.toISOString()}` : "";
  return {
    at: run.startedAt.toISOString(),
    kind: "backup",
    severity: run.status === "FAILED" ? "warning" : "info",
    title: `Backup ${run.status.toLowerCase()}`,
    detail: run.errorMessage ?? `${run.kind} run${finished}`,
    actor: null
  };
};

/** ONE row becomes TWO entries when the condition has cleared — the bookends that make
 *  "when did this start, and when did it stop" readable in one scroll. */
const alertEntries = (alert: AlertRow): TimelineEntry[] => {
  const opened: TimelineEntry = {
    at: alert.firstSeenAt.toISOString(),
    kind: "alert",
    severity: (alert.severity as TimelineEntry["severity"]) ?? "info",
    title: alert.title,
    detail: alert.detail,
    actor: null
  };
  if (!alert.resolvedAt) return [opened];
  return [
    opened,
    {
      at: alert.resolvedAt.toISOString(),
      kind: "alert-cleared",
      severity: "info",
      title: `Cleared: ${alert.title}`,
      detail: `Open from ${alert.firstSeenAt.toISOString()}.`,
      actor: null
    }
  ];
};

/** Null when the broadcast never reached this workspace: broadcasts are fleet-wide rows, and which
 *  workspaces they touched lives in `outcomes` rather than in a foreign key. */
const broadcastEntry = (broadcast: BroadcastRow, orgId: string): TimelineEntry | null => {
  const outcomes = Array.isArray(broadcast.outcomes) ? (broadcast.outcomes as Array<{ organizationId?: string; ok?: boolean; error?: string | null }>) : [];
  const mine = outcomes.find((outcome) => outcome.organizationId === orgId);
  if (!mine) return null;
  const failed = mine.ok === false;
  return {
    at: broadcast.createdAt.toISOString(),
    kind: "maintenance",
    severity: failed ? "warning" : "info",
    title: broadcast.enabled ? "Maintenance window armed" : "Maintenance window lifted",
    detail: failed ? `Did not apply: ${mine.error ?? "unknown error"}` : (broadcast.message ?? ""),
    actor: broadcast.actorLabel
  };
};

const emailEntry = (email: EmailRow): TimelineEntry => ({
  at: email.createdAt.toISOString(),
  kind: "email",
  severity: "warning",
  title: `Platform email ${email.status.toLowerCase()}: ${email.templateKey}`,
  detail: email.errorMessage ?? "",
  actor: null
});
