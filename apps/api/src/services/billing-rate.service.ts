/**
 * WHAT: resolves "which hourly rate applies to this piece of work" and freezes it onto the
 * timesheet at approval time.
 *
 * WHY this exists at all: before it, cost was derived live from `User.hourlyRate` every time
 * anyone looked (see report.controller.ts's cost-insights). That means giving somebody a raise
 * retroactively changed what last quarter's work "cost". That's tolerable for an internal
 * dashboard and disqualifying for a Verified Work Attestation, which a client may dispute months
 * later — the number on the artifact has to be the number that was true when the work was
 * approved, permanently.
 *
 * WHY approval time specifically (not submit, not creation): approval is the moment the
 * organisation accepts the hours as real. Before that the entry can still be edited or rejected,
 * so snapshotting earlier would freeze a number against work that might never be accepted.
 *
 * WHO calls this: `timesheet.controller.ts`'s approve route, which merges
 * `buildRateSnapshotPatch`'s result into the SAME update that sets status APPROVED — deliberately
 * one write, so there is no window where a row is approved but unsnapshotted, and no new failure
 * path in the approval flow.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { getGlobalTicketSettings } from "./ticket.service.js";

/** Where the applied rate came from. Stored on the timesheet so an attestation can explain
 *  itself ("billed at the project rate" vs "billed at the individual's rate"). */
export type BilledRateSource = "PROJECT" | "USER" | "NONE";

export interface ResolvedBillingRate {
  /** Null when no rate is configured anywhere — this is a legitimate, non-error state. */
  rate: Prisma.Decimal | null;
  source: BilledRateSource;
  currency: string;
}

/**
 * Project override wins over the individual's rate. That ordering is the real-world case: an
 * agency charges a client a negotiated project rate regardless of which of its people does the
 * work, and only falls back to per-person rates when no such deal exists.
 *
 * Returns `source: "NONE"` rather than throwing when nothing is configured — see
 * `buildRateSnapshotPatch` for why that must never block an approval.
 */
export async function resolveBillingRate(params: { userId: string; projectId: string }): Promise<ResolvedBillingRate> {
  const [project, user, settings] = await Promise.all([
    prisma.project.findUnique({
      where: { id: params.projectId },
      select: { defaultHourlyRate: true, billingCurrency: true }
    }),
    prisma.user.findUnique({ where: { id: params.userId }, select: { hourlyRate: true } }),
    getGlobalTicketSettings()
  ]);

  const currency = project?.billingCurrency || settings.defaultCurrency || "USD";

  if (project?.defaultHourlyRate != null) {
    return { rate: new Prisma.Decimal(project.defaultHourlyRate), source: "PROJECT", currency };
  }
  if (user?.hourlyRate != null) {
    return { rate: new Prisma.Decimal(user.hourlyRate), source: "USER", currency };
  }
  return { rate: null, source: "NONE", currency };
}

/** The columns an approval writes. Shaped as a patch object so the caller can spread it into its
 *  existing `prisma.timesheet.update` rather than issuing a second write. */
export interface RateSnapshotPatch {
  billedRate: Prisma.Decimal | null;
  billedRateSource: BilledRateSource;
  billedCurrency: string;
  billedAmount: Prisma.Decimal | null;
  rateSnapshotAt: Date;
}

/**
 * Builds the snapshot for a timesheet being approved.
 *
 * **Approval never fails because billing isn't configured.** If no rate exists anywhere this
 * records `source: "NONE"` and approves normally — blocking a manager from approving real work
 * because an admin hasn't filled in a rate would break the app's core workflow to serve a
 * reporting feature. The attestation surfaces those hours as explicitly "unrated" instead of
 * quietly pretending they're worth 0, which is what the old live-rate path did.
 *
 * Money is computed in `Prisma.Decimal`, never JS floats — `0.1 + 0.2` problems in an artifact a
 * client might audit are not acceptable.
 */
export async function buildRateSnapshotPatch(timesheet: {
  userId: string;
  projectId: string;
  totalHours: Prisma.Decimal | number;
  billable: boolean;
}): Promise<RateSnapshotPatch> {
  const resolved = await resolveBillingRate({ userId: timesheet.userId, projectId: timesheet.projectId });

  // A non-billable entry still records the rate that WOULD have applied (useful when someone
  // later asks "what did we absorb on this account?"), but its amount is a hard zero.
  let billedAmount: Prisma.Decimal | null = null;
  if (!timesheet.billable) {
    billedAmount = new Prisma.Decimal(0);
  } else if (resolved.rate) {
    billedAmount = resolved.rate.mul(new Prisma.Decimal(timesheet.totalHours));
  }

  return {
    billedRate: resolved.rate,
    billedRateSource: resolved.source,
    billedCurrency: resolved.currency,
    billedAmount,
    rateSnapshotAt: new Date()
  };
}

/**
 * Clears a snapshot. Nothing calls this today — approve/reject both require SUBMITTED, so an
 * already-approved timesheet cannot currently return to an editable state. It exists so that
 * whoever adds an "un-approve" path has the correct behaviour to hand rather than inventing it:
 * the snapshot must be cleared, because it would otherwise assert a rate for work that is no
 * longer approved.
 *
 * Note that already-ISSUED attestations are unaffected by design — they carry a frozen payload,
 * so a later correction shows up as a NEW attestation (or a void), never as an old artifact
 * silently changing its numbers.
 */
export function clearRateSnapshotPatch(): {
  billedRate: null;
  billedRateSource: null;
  billedCurrency: null;
  billedAmount: null;
  rateSnapshotAt: null;
} {
  return {
    billedRate: null,
    billedRateSource: null,
    billedCurrency: null,
    billedAmount: null,
    rateSnapshotAt: null
  };
}

/**
 * The single cost formula, shared by every consumer so they can't drift — this used to be
 * duplicated verbatim in report.controller.ts and ai.controller.ts.
 *
 * Prefers the frozen snapshot. Falls back to the live rate ONLY for rows approved before
 * snapshotting existed, and reports those hours separately as `unratedHours` so a caller can
 * always tell how much of a total is backed by a real historical rate versus reconstructed.
 */
export function computeTimesheetCost(
  rows: Array<{
    totalHours: Prisma.Decimal | number;
    billable?: boolean;
    billedAmount?: Prisma.Decimal | number | null;
    billedRate?: Prisma.Decimal | number | null;
    liveFallbackRate?: Prisma.Decimal | number | null;
  }>
): { amount: number; unratedHours: number } {
  let amount = new Prisma.Decimal(0);
  let unratedHours = new Prisma.Decimal(0);

  for (const row of rows) {
    const hours = new Prisma.Decimal(row.totalHours);
    if (row.billable === false) continue;

    if (row.billedAmount != null) {
      amount = amount.add(new Prisma.Decimal(row.billedAmount));
      continue;
    }
    const rate = row.billedRate ?? row.liveFallbackRate;
    if (rate == null) {
      unratedHours = unratedHours.add(hours);
      continue;
    }
    amount = amount.add(new Prisma.Decimal(rate).mul(hours));
  }

  return { amount: Number(amount.toFixed(2)), unratedHours: Number(unratedHours.toFixed(2)) };
}
