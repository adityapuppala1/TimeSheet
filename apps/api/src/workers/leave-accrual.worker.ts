/**
 * V17 Phase B — leave accrual and year-end rollover, daily at 02:20 server time, for every org
 * whose leave gate is open (toggle AND plan).
 *
 * WHY DAILY FOR A MONTHLY JOB: the run only posts what is DUE and missing, so running every day is
 * free and self-healing — a server that was down on the 1st posts the month's credit on the 2nd.
 * Nothing is ever computed from "when did the worker last run".
 *
 * IDEMPOTENT BY KEY, not by bookkeeping: every row carries an idempotencyKey that is UNIQUE in the
 * database — `ACCRUAL:<user>:<type>:<YYYY-MM>`, `EXPIRY:<user>:<type>:<closingYear>`,
 * `CARRY:<user>:<type>:<newYear>` — and is written with createMany({ skipDuplicates }). Re-running,
 * two app instances racing, or a manual re-run all converge on the same ledger
 * (tests/unit/leave-accrual.test.ts runs it twice and counts).
 *
 * ROLLOVER: on (or after) the first day of a leave year, each person/type's CLOSING balance is
 * settled — up to carryForwardMax carries into the new year, the rest expires (leave-calc.ts#
 * rolloverDeltas). A debt (negative balance on an allowNegative type) carries in full. The closing
 * year's due-but-unposted accrual is posted first, so a year is never settled short. Movement in a
 * year AFTER it was settled (a December request approved in January, a cancellation, a backdated
 * debit) is re-settled into the new year by leave-settlement.service.ts; this run also heals any
 * residual such a movement left by racing it (reconcileSettled).
 *
 * Sends nothing. It writes ledger rows only; there is no email leg to worry about on a dev box.
 */
import cron from "node-cron";
import type { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { serverTimezone } from "../config/env.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { getAttendanceSettings } from "../services/attendance-settings.service.js";
import { todayKeyFor } from "../services/attendance-day-status.js";
import { isLeaveOn } from "../services/leave.service.js";
import { accrualDueThrough, inPolicyScope, leaveYearBounds, leaveYearOf, rolloverDeltas, type ScopedPerson } from "../services/leave-calc.js";
import { settleLateMovement } from "../services/leave-settlement.service.js";
import { COUNTED_PEOPLE } from "../services/people-visibility.service.js";
import { runOncePerTick } from "../services/job-claim.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";
import { sweepOrphanLeaveUploads } from "../services/leave-upload-cleanup.service.js";
import { expireCompOffCredits } from "../services/comp-off.service.js";

let started = false;
let running = false;

const toKey = (d: Date) => d.toISOString().slice(0, 10);

export interface AccrualRunResult {
  accrued: number;
  rolledOver: number;
}

/** One org's run. Exported for tests and for a manual "run now". */
export async function runLeaveAccrual(now: Date = new Date()): Promise<AccrualRunResult> {
  if (!(await isLeaveOn())) return { accrued: 0, rolledOver: 0 };
  const settings = await getAttendanceSettings();
  const startMonth = settings.leaveYearStartMonth ?? 1;
  const today = todayKeyFor(now, null, serverTimezone);
  const year = leaveYearOf(today, startMonth);

  const [types, people] = await Promise.all([
    prisma.leaveType.findMany({ where: { enabled: true } }),
    prisma.user.findMany({ where: { ...COUNTED_PEOPLE, status: "ACTIVE" }, select: { id: true, createdAt: true, employmentType: true, siteId: true }, take: 50_000 })
  ]);
  if (types.length === 0 || people.length === 0) return { accrued: 0, rolledOver: 0 };

  const where = { leaveYear: year - 1, userId: { in: people.map((p) => p.id) }, leaveTypeId: { in: types.map((t) => t.id) } };
  const accrued = (await insertKeyed(await closingAccrualRows(people, types, year, startMonth, where))) + (await insertKeyed(accrualRows(people, types, year, startMonth, today)));

  // Rollover: settle the closing year once (the keys make every later run a no-op).
  const sums = await prisma.leaveBalanceLedger.groupBy({ by: ["userId", "leaveTypeId"], where, _sum: { delta: true } });
  const typeById = new Map(types.map((t) => [t.id, t]));
  const rollRows = sums.flatMap((s) => {
    const t = typeById.get(s.leaveTypeId);
    return t ? rolloverRows(s.userId, t, Number(s._sum.delta ?? 0), year) : [];
  });
  let rolledOver = await insertKeyed(rollRows);
  rolledOver += await reconcileSettled(where, typeById, year - 1);
  return { accrued, rolledOver };
}

/**
 * The closing year's due-but-unposted slots (a server that was down for December's run, or the 1st
 * of the year before 02:20): a year must be settled WITH its full accrual. Only for a person/type
 * that has ledger activity in the closing year and is NOT settled yet — a type created this year
 * must not be handed last year's quota (and then carry it), and a settled year is never reopened
 * by accrual. Keyed, so a slot already posted is skipped.
 */
async function closingAccrualRows(
  people: ReadonlyArray<AccrualPerson>,
  types: readonly TypeRow[],
  year: number,
  startMonth: number,
  where: Prisma.LeaveBalanceLedgerWhereInput
): Promise<Prisma.LeaveBalanceLedgerCreateManyInput[]> {
  const groups = await prisma.leaveBalanceLedger.groupBy({ by: ["userId", "leaveTypeId", "kind"], where, _sum: { delta: true } });
  const active = new Set(groups.map((g) => `${g.userId}|${g.leaveTypeId}`));
  const settled = new Set(groups.filter((g) => g.kind === "EXPIRY").map((g) => `${g.userId}|${g.leaveTypeId}`));
  const closingEnd = leaveYearBounds(year - 1, startMonth).to;
  return accrualRows(people, types, year - 1, startMonth, closingEnd).filter((r) => {
    const k = `${r.userId}|${r.leaveTypeId}`;
    return active.has(k) && !settled.has(k);
  });
}

/**
 * A settled year must sit at zero. A late movement normally re-settles itself in its own
 * transaction (leave-settlement.service.ts); one that raced this run (written between the sums
 * above and the EXPIRY insert) would be left behind. Re-settle any residual. The source key names
 * the year's row count, so a given state is settled once however often this runs.
 */
async function reconcileSettled(where: Prisma.LeaveBalanceLedgerWhereInput, typeById: Map<string, TypeRow>, closing: number): Promise<number> {
  const after = await prisma.leaveBalanceLedger.groupBy({ by: ["userId", "leaveTypeId"], where, _sum: { delta: true }, _count: { _all: true } });
  let written = 0;
  for (const s of after) {
    const t = typeById.get(s.leaveTypeId);
    if (!t || Math.round(Number(s._sum.delta ?? 0) * 100) === 0) continue;
    const count = (s as { _count?: { _all?: number } })._count?._all ?? 0;
    const sourceKey = `RECON:${s.userId}:${t.id}:${closing}:${count}`;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${s.userId} FOR UPDATE`;
      const exists = await tx.leaveBalanceLedger.findFirst({ where: { idempotencyKey: `SETTLE-CLOSE:${sourceKey}` }, select: { id: true } });
      if (exists) return;
      written += (await settleLateMovement(tx, { userId: s.userId, type: t, year: closing, sourceKey })).written;
    });
  }
  return written;
}

type TypeRow = { id: string; code: string; annualQuota: unknown; accrual: "YEARLY_UPFRONT" | "MONTHLY_PRORATA"; carryForwardMax: unknown; scopeEmploymentTypes?: unknown; scopeSiteIds?: unknown };
type AccrualPerson = { id: string; createdAt: Date } & ScopedPerson;

/**
 * Every slot due this leave year for every person and type — keyed, so posted ones are skipped.
 * 7.0.0: a type scoped to employment types / sites accrues only for people in its scope.
 */
function accrualRows(people: ReadonlyArray<AccrualPerson>, types: readonly TypeRow[], year: number, startMonth: number, today: string) {
  const rows: Prisma.LeaveBalanceLedgerCreateManyInput[] = [];
  for (const p of people) {
    for (const t of types) {
      if (!inPolicyScope(t, p)) continue;
      for (const slot of accrualDueThrough({ annualQuota: Number(t.annualQuota), accrual: t.accrual }, year, startMonth, today, toKey(p.createdAt))) {
        rows.push({
          userId: p.id,
          leaveTypeId: t.id,
          leaveYear: year,
          delta: slot.amount,
          kind: "ACCRUAL",
          reason: `${t.code} accrual ${slot.period}`,
          idempotencyKey: `ACCRUAL:${p.id}:${t.id}:${slot.period}`
        });
      }
    }
  }
  return rows;
}

/** The EXPIRY (closing year) and CARRY_FORWARD (new year) rows for one closing balance. */
function rolloverRows(userId: string, t: TypeRow, closingBalance: number, year: number): Prisma.LeaveBalanceLedgerCreateManyInput[] {
  const closing = year - 1;
  const { expire, carry } = rolloverDeltas(closingBalance, Number(t.carryForwardMax));
  const rows: Prisma.LeaveBalanceLedgerCreateManyInput[] = [];
  if (expire !== 0) {
    rows.push({
      userId,
      leaveTypeId: t.id,
      leaveYear: closing,
      delta: expire,
      kind: "EXPIRY",
      reason: expire < 0 ? `${t.code} unused days lapsed at year end` : `${t.code} debt moved to ${year}`,
      idempotencyKey: `EXPIRY:${userId}:${t.id}:${closing}`
    });
  }
  if (carry !== 0) {
    rows.push({
      userId,
      leaveTypeId: t.id,
      leaveYear: year,
      delta: carry,
      kind: "CARRY_FORWARD",
      reason: `${t.code} carried forward from ${closing}`,
      idempotencyKey: `CARRY:${userId}:${t.id}:${year}`
    });
  }
  return rows;
}

/** createMany in chunks, skipping rows whose idempotencyKey already exists. Returns rows written. */
async function insertKeyed(rows: Prisma.LeaveBalanceLedgerCreateManyInput[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    written += (await prisma.leaveBalanceLedger.createMany({ data: rows.slice(i, i + 1000), skipDuplicates: true })).count;
  }
  return written;
}

export function startLeaveAccrualWorker(): void {
  if (started) return;
  started = true;
  cron.schedule("20 2 * * *", () => {
    if (running) return;
    running = true;
    runOncePerTick("leave-accrual", "day", () =>
      runForEveryOrg("leave-accrual", async () => {
        const r = await runLeaveAccrual();
        // 7.0.0: comp-off credits past their expiry (keyed, so a re-run expires nothing twice).
        const compOffExpired = await expireCompOffCredits();
        if (compOffExpired > 0) console.info(`[leave-accrual] ${requireTenantContext().orgSlug}: expired ${compOffExpired} comp-off credit(s).`);
        // Leave documents stored for a request that was never created (7.0.0). Leave-gated like the run.
        const swept = (await isLeaveOn()) ? await sweepOrphanLeaveUploads() : 0;
        if (swept > 0) console.info(`[leave-accrual] ${requireTenantContext().orgSlug}: removed ${swept} orphaned leave upload(s).`);
        if (r.accrued + r.rolledOver > 0) {
          console.info(`[leave-accrual] ${requireTenantContext().orgSlug}: ${r.accrued} accrual and ${r.rolledOver} rollover row(s).`);
        }
      })
    )
      .catch((error) => console.error("[leave-accrual] run failed:", (error as Error).message))
      .finally(() => {
        running = false;
      });
  });
  console.info("[leave-accrual] worker scheduled (02:20 daily).");
}
