/**
 * V17 Phase B — late movements in a leave year that has already been SETTLED at year end.
 *
 * THE PROBLEM: the rollover (workers/leave-accrual.worker.ts) closes year Y once — an EXPIRY row
 * brings Y to zero and a CARRY_FORWARD row moves up to carryForwardMax into Y+1. Ledger movement
 * for Y can still happen after that: a December request approved in January, an approved
 * December leave cancelled in January (reversal), a backdated debit on an allowNegative type, an
 * HRMS recording old leave. Without this module those rows land in a year nobody looks at again,
 * and Y+1's carry is wrong forever.
 *
 * THE RULE: once Y is settled, every later movement in Y is ALSO reflected into Y+1, as if the
 * rollover were re-run with it: the carry Y should have produced is recomputed from Y's whole
 * activity (rolloverDeltas, so the carryForwardMax cap and "a debt carries in full" both hold), and
 * the DIFFERENCE from what was already carried is posted to Y+1. Y itself is brought back to zero
 * by an offsetting EXPIRY row. Two rows per movement, both keyed on the source row:
 *   - `SETTLE-CLOSE:<sourceKey>` (EXPIRY, year Y)   — Y back to zero;
 *   - `SETTLE:<sourceKey>`       (ADJUSTMENT, year Y+1) — the change in carry (omitted when zero).
 * The keys are UNIQUE in the database, so a retry posts nothing twice. When Y+1 is ALSO settled the
 * change is re-settled there in turn (keys suffixed `@<year>`), cascading until an open year.
 *
 * NOT SETTLED YET (no EXPIRY/CARRY key for Y, e.g. the closing balance was zero, or the worker has
 * not run yet this year): nothing to do — the next rollover run settles Y with the movement in it.
 * A movement racing the worker is healed by reconcileSettledYear, which the worker runs every day.
 */
import type { Prisma } from "@prisma/client";
import { rolloverDeltas } from "./leave-calc.js";

type Tx = Prisma.TransactionClient;
type TypeRules = { id: string; code: string; carryForwardMax: unknown };

const r2 = (n: number) => Math.round(n * 100) / 100;

export const expiryKey = (userId: string, typeId: string, closingYear: number) => `EXPIRY:${userId}:${typeId}:${closingYear}`;
export const carryKey = (userId: string, typeId: string, newYear: number) => `CARRY:${userId}:${typeId}:${newYear}`;

/** Has year `year` been closed by the rollover for this person and type? */
export async function isYearSettled(db: Tx, userId: string, typeId: string, year: number): Promise<boolean> {
  const rows = await db.leaveBalanceLedger.findMany({
    where: { idempotencyKey: { in: [expiryKey(userId, typeId, year), carryKey(userId, typeId, year + 1)] } },
    select: { id: true },
    take: 1
  });
  return rows.length > 0;
}

export interface SettlementFacts {
  /** Every row of the closed year EXCEPT the settlement transfers: what the year had before closing. */
  activity: number;
  /** Everything in the closed year (zero right after a settlement). */
  closedSum: number;
  /** What the new year has received so far: the CARRY_FORWARD row plus earlier SETTLE rows. */
  carried: number;
  /** The new year's ledger sum (for "has the carried part already been spent?"). */
  newYearSum: number;
}

export async function settlementFacts(db: Tx, userId: string, typeId: string, year: number): Promise<SettlementFacts> {
  const [closed, next] = await Promise.all([
    db.leaveBalanceLedger.groupBy({ by: ["kind"], where: { userId, leaveTypeId: typeId, leaveYear: year }, _sum: { delta: true } }),
    db.leaveBalanceLedger.findMany({
      where: { userId, leaveTypeId: typeId, leaveYear: year + 1 },
      select: { delta: true, kind: true, idempotencyKey: true }
    })
  ]);
  let activity = 0;
  let closedSum = 0;
  for (const g of closed) {
    const v = Number(g._sum.delta ?? 0);
    closedSum += v;
    if (g.kind !== "EXPIRY") activity += v;
  }
  let carried = 0;
  let newYearSum = 0;
  for (const row of next) {
    const v = Number(row.delta);
    newYearSum += v;
    if (row.kind === "CARRY_FORWARD" || (row.kind === "ADJUSTMENT" && row.idempotencyKey?.startsWith("SETTLE:"))) carried += v;
  }
  return { activity: r2(activity), closedSum: r2(closedSum), carried: r2(carried), newYearSum: r2(newYearSum) };
}

/** How the new year's carry changes when the closed year's activity becomes `activity`. Pure. */
export function carryChange(activity: number, carried: number, carryForwardMax: number): number {
  return r2(rolloverDeltas(activity, carryForwardMax).carry - carried);
}

/**
 * Call AFTER writing a ledger row into `year` (same transaction, person already locked). Re-settles
 * a closed year with that row in it. Returns the change posted to year+1 (0 when the year is not
 * settled, or the carry does not move) and how many rows were written.
 */
export async function settleLateMovement(
  db: Tx,
  args: { userId: string; type: TypeRules; year: number; sourceKey: string; actorId?: string | null }
): Promise<{ change: number; written: number }> {
  const { userId, type, year, sourceKey } = args;
  const none = { change: 0, written: 0 };
  if (!(await isYearSettled(db, userId, type.id, year))) return none;
  const facts = await settlementFacts(db, userId, type.id, year);
  if (facts.closedSum === 0) return none;
  const change = carryChange(facts.activity, facts.carried, Number(type.carryForwardMax));
  await db.leaveBalanceLedger.create({
    data: {
      userId,
      leaveTypeId: type.id,
      leaveYear: year,
      delta: -facts.closedSum,
      kind: "EXPIRY",
      reason: `${type.code} ${year} re-settled after a late change`,
      actorId: args.actorId ?? null,
      idempotencyKey: `SETTLE-CLOSE:${sourceKey}`
    }
  });
  if (change !== 0) {
    await db.leaveBalanceLedger.create({
      data: {
        userId,
        leaveTypeId: type.id,
        leaveYear: year + 1,
        delta: change,
        kind: "ADJUSTMENT",
        reason: `${type.code} carry-forward from ${year} corrected after a late change`,
        actorId: args.actorId ?? null,
        idempotencyKey: `SETTLE:${sourceKey}`
      }
    });
  }
  let written = change === 0 ? 1 : 2;
  // CASCADE: the change just landed in year+1. If year+1 is itself already settled, that row is a
  // late movement THERE too, so re-settle it the same way (and so on, year by year). Without this a
  // movement two or more years back leaves its change stranded as a residual in a closed year.
  // The key names the year, so each level is idempotent on its own and the first level's keys are
  // unchanged.
  if (change !== 0) {
    const next = await settleLateMovement(db, { ...args, year: year + 1, sourceKey: `${sourceKey}@${year + 1}` });
    written += next.written;
  }
  return { change, written };
}
