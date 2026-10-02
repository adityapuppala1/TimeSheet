/**
 * WHAT: approval-SLA breaches, COUNTED in the database — for the home page and Reports tiles
 * (admin-summary.service.ts), the Team page (team.controller.ts) and the Practice Update.
 *
 * THE RULE (workspace-metrics.ts): an approval deadline that passed before a decision —
 * `(reviewedAt ?? now) > approvalDeadline` — counted for the deadlines that fell in the window.
 * Never read from `slaBreachAt`, which only the escalation sweep writes, and only while SLA_ENABLED
 * is on.
 *
 * WHY A RAW COUNT: every caller used to load each `{approvalDeadline, reviewedAt}` row in the window
 * and filter in Node. The home page polls every 120 s and asks for the window AND its comparison
 * window, so "This year" on a 500-person workspace read about 250,000 rows per poll per admin tab.
 * The window's upper bound is clamped to now, so every deadline inside it has already passed: a row
 * is a breach exactly when it is still unreviewed or was reviewed after its deadline. Comparing two
 * columns is something Prisma's `where` cannot express, so it is one `COUNT(*)` in SQL.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";

export interface ApprovalSlaWindow {
  gte: Date;
  /** Exclusive; open-ended windows run to now. Clamped to now either way. */
  lt?: Date;
}

/** Restricts the count to these people and/or projects. An empty list means nobody. */
export interface ApprovalSlaScope {
  userIds?: string[];
  projectIds?: string[];
}

function breachQuery(window: ApprovalSlaWindow, now: Date, scope: ApprovalSlaScope, groupBy?: "userId" | "projectId"): Prisma.Sql | null {
  const upper = window.lt && window.lt < now ? window.lt : now;
  if (upper <= window.gte || scope.userIds?.length === 0 || scope.projectIds?.length === 0) return null;
  const users = scope.userIds ? Prisma.sql`AND t.userId IN (${Prisma.join(scope.userIds)})` : Prisma.empty;
  const projects = scope.projectIds ? Prisma.sql`AND t.projectId IN (${Prisma.join(scope.projectIds)})` : Prisma.empty;
  // A fixed column name from a two-value union — never caller text — so raw is safe here.
  const key = groupBy ? Prisma.raw(`t.${groupBy}`) : null;
  return Prisma.sql`
    SELECT ${key ? Prisma.sql`${key} AS k, ` : Prisma.empty}COUNT(*) AS n
    FROM Timesheet t
    WHERE t.approvalDeadline >= ${window.gte} AND t.approvalDeadline < ${upper}
      AND (t.reviewedAt IS NULL OR t.reviewedAt > t.approvalDeadline)
      AND t.deletedAt IS NULL
      ${users} ${projects}
    ${key ? Prisma.sql`GROUP BY ${key}` : Prisma.empty}
  `;
}

/** Approval-SLA breaches whose deadline fell in the window. */
export async function countApprovalSlaBreaches(window: ApprovalSlaWindow, now: Date, scope: ApprovalSlaScope = {}): Promise<number> {
  const query = breachQuery(window, now, scope);
  if (!query) return 0;
  const rows = await prisma.$queryRaw<Array<{ n: bigint | number }>>(query);
  return Number(rows[0]?.n ?? 0);
}

/** The same count per person or per project. Anyone with none is absent from the map. */
export async function countApprovalSlaBreachesBy(
  key: "userId" | "projectId",
  window: ApprovalSlaWindow,
  now: Date,
  scope: ApprovalSlaScope = {}
): Promise<Map<string, number>> {
  const query = breachQuery(window, now, scope, key);
  if (!query) return new Map();
  const rows = await prisma.$queryRaw<Array<{ k: string; n: bigint | number }>>(query);
  return new Map(rows.map((r) => [r.k, Number(r.n)]));
}
