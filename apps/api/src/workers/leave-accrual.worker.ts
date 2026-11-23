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
 * rolloverDeltas). A debt (negative balance on an allowNegative type) carries in full.
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
import { accrualDueThrough, leaveYearOf, rolloverDeltas } from "../services/leave-calc.js";
import { COUNTED_PEOPLE } from "../services/people-visibility.service.js";
import { runOncePerTick } from "../services/job-claim.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

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
    prisma.user.findMany({ where: { ...COUNTED_PEOPLE, status: "ACTIVE" }, select: { id: true, createdAt: true }, take: 50_000 })
  ]);
  if (types.length === 0 || people.length === 0) return { accrued: 0, rolledOver: 0 };

  const accrued = await insertKeyed(accrualRows(people, types, year, startMonth, today));

  // Rollover: settle the closing year once (the keys make every later run a no-op).
  const sums = await prisma.leaveBalanceLedger.groupBy({
    by: ["userId", "leaveTypeId"],
    where: { leaveYear: year - 1, userId: { in: people.map((p) => p.id) }, leaveTypeId: { in: types.map((t) => t.id) } },
    _sum: { delta: true }
  });
  const typeById = new Map(types.map((t) => [t.id, t]));
  const rollRows = sums.flatMap((s) => {
    const t = typeById.get(s.leaveTypeId);
    return t ? rolloverRows(s.userId, t, Number(s._sum.delta ?? 0), year) : [];
  });
  const rolledOver = await insertKeyed(rollRows);
  return { accrued, rolledOver };
}

type TypeRow = { id: string; code: string; annualQuota: unknown; accrual: "YEARLY_UPFRONT" | "MONTHLY_PRORATA"; carryForwardMax: unknown };

/** Every slot due this leave year for every person and type — keyed, so posted ones are skipped. */
function accrualRows(people: ReadonlyArray<{ id: string; createdAt: Date }>, types: readonly TypeRow[], year: number, startMonth: number, today: string) {
  const rows: Prisma.LeaveBalanceLedgerCreateManyInput[] = [];
  for (const p of people) {
    for (const t of types) {
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
