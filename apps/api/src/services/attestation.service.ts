/**
 * WHAT: builds a **Verified Work Attestation** — the client-facing artifact proving "these
 * approved hours map to these tickets, were done by these (identity-verified) people, were
 * approved by this manager, at this rate."
 *
 * WHY this is the product's sharpest artifact: this app is one of the few systems that holds all
 * four halves of that sentence at once. An attendance tool can prove someone clocked in but has no
 * work object to attach it to; a PM tool knows the work but not the hours or who physically did
 * it. Because tickets, timesheets, approvals and (optionally) biometric identity checks all live
 * in the same tenant database, the chain can be asserted end-to-end.
 *
 * WHY one shared builder: exactly the reasoning security-report.service.ts gives — the JSON
 * download, the PDF, the persisted payload, and (behind its own toggle) the public share view all
 * render from this one function, so they can never disagree about what was attested.
 *
 * WHAT IT DELIBERATELY OMITS: no face embeddings, no captured-image paths, no similarity scores or
 * thresholds, no IP addresses, no rejection reasons, no per-person rates outside the period, and
 * nothing from another project. Same stripping discipline as the existing identity evidence pack
 * (face.controller.ts) — an attestation is meant to be handed to an outside party, so it carries
 * the CONCLUSION of an identity check ("verified"), never the biometric internals behind it. For
 * the internals, an internal admin follows the linked evidence-pack route instead.
 */
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { htmlToText } from "../utils/sanitize.js";
import { getGlobalTicketSettings } from "./ticket.service.js";

export interface AttestationEntry {
  workDate: string;
  hours: number;
  activityType: string;
  task: string;
  person: string;
  rate: number | null;
  rateSource: string | null;
  amount: number | null;
  /** True when a passed, consumed face check is bound to this specific timesheet's submission. */
  identityVerified: boolean;
}

export interface AttestationWorkItem {
  ticketKey: string | null;
  ticketTitle: string;
  hours: number;
  amount: number;
  entries: AttestationEntry[];
}

export interface AttestationPayload {
  attestation: {
    reference: string;
    generatedAt: string;
    generatedBy: string | null;
    project: { code: string; name: string; clientName: string | null };
    period: { start: string; end: string };
    currency: string;
  };
  summary: {
    totalHours: number;
    billableHours: number;
    unratedHours: number;
    totalAmount: number;
    entryCount: number;
    contributorCount: number;
    identityVerifiedEntries: number;
    approvedEntries: number;
  };
  workItems: AttestationWorkItem[];
  contributors: Array<{ name: string; hours: number; entries: number; identityVerifiedEntries: number }>;
  approvals: Array<{ approver: string; entries: number; identityVerified: boolean }>;
  /** Plain-language limitations printed on the artifact. An artifact that hides what it doesn't
   *  cover is worse than useless in a dispute. */
  caveats: string[];
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** e.g. ATT-HICS-OPS-20260701-4F2A9C — project + period + short random, human-quotable. */
function buildReference(projectCode: string, periodStart: Date): string {
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `ATT-${projectCode}-${toIsoDate(periodStart).replace(/-/g, "")}-${suffix}`.slice(0, 40);
}

/** Stable stringify so the same payload always hashes identically regardless of key insertion
 *  order — otherwise the tamper-evidence hash would be meaningless. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function hashPayload(payload: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export interface BuiltAttestation {
  payload: AttestationPayload;
  totals: {
    totalHours: Prisma.Decimal;
    billableHours: Prisma.Decimal;
    unratedHours: Prisma.Decimal;
    totalAmount: Prisma.Decimal;
    entryCount: number;
    currency: string;
  };
}

export async function buildWorkAttestation(params: {
  projectId: string;
  periodStart: Date;
  periodEnd: Date;
  generatedByName?: string | null;
  reference?: string;
}): Promise<BuiltAttestation> {
  const project = await prisma.project.findFirst({
    where: { id: params.projectId, deletedAt: null },
    select: { id: true, code: true, name: true, clientName: true, billingCurrency: true }
  });
  if (!project) throw new AppError(404, "Project not found");

  const settings = await getGlobalTicketSettings();

  // APPROVED only, always. An attestation asserts accepted work — including draft or rejected
  // hours would make it a claim about work nobody signed off on.
  const timesheets = await prisma.timesheet.findMany({
    where: {
      projectId: project.id,
      deletedAt: null,
      status: "APPROVED",
      workDate: { gte: params.periodStart, lte: params.periodEnd }
    },
    select: {
      id: true,
      workDate: true,
      totalHours: true,
      activityType: true,
      taskDescription: true,
      billable: true,
      billedRate: true,
      billedRateSource: true,
      billedCurrency: true,
      billedAmount: true,
      reviewedById: true,
      user: { select: { id: true, name: true } },
      ticket: { select: { key: true, title: true } }
    },
    orderBy: [{ workDate: "asc" }]
  });

  // Currency safety: refuse rather than silently summing mixed currencies into one meaningless
  // total. Only rows that actually carry a snapshot currency count toward this check.
  const currencies = new Set(timesheets.map((t) => t.billedCurrency).filter((c): c is string => Boolean(c)));
  if (currencies.size > 1) {
    throw new AppError(
      422,
      `This period mixes currencies (${[...currencies].join(", ")}). Issue one attestation per currency, or align the project's billing currency.`
    );
  }
  const currency = [...currencies][0] ?? project.billingCurrency ?? settings.defaultCurrency ?? "USD";

  // Identity: which of these timesheets carry a passed, consumed face check — for the submitter
  // (context TIMESHEET) and for the approver (context APPROVAL). Note `timesheetId` on
  // FaceVerificationAttempt is a loose VarChar, not an FK, so this is an explicit `in` lookup.
  const timesheetIds = timesheets.map((t) => t.id);
  const attempts =
    timesheetIds.length > 0
      ? await prisma.faceVerificationAttempt.findMany({
          where: { timesheetId: { in: timesheetIds }, outcome: "PASSED", consumedAt: { not: null } },
          // Only the fields needed to say "verified" — deliberately NOT similarity, threshold,
          // imagePath, ipAddress or any provenance internals. See this file's header.
          select: { timesheetId: true, context: true }
        })
      : [];
  const submitterVerified = new Set(attempts.filter((a) => a.context === "TIMESHEET").map((a) => a.timesheetId));
  const approverVerified = new Set(attempts.filter((a) => a.context === "APPROVAL").map((a) => a.timesheetId));

  // `Timesheet.reviewedById` has no Prisma relation, so approvers need a batched second lookup
  // rather than an include (the identity evidence pack does the same thing one row at a time).
  const reviewerIds = [...new Set(timesheets.map((t) => t.reviewedById).filter((id): id is string => Boolean(id)))];
  const reviewers =
    reviewerIds.length > 0 ? await prisma.user.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, name: true } }) : [];
  const reviewerName = new Map(reviewers.map((r) => [r.id, r.name]));

  // --- aggregate -------------------------------------------------------------------------
  let totalHours = new Prisma.Decimal(0);
  let billableHours = new Prisma.Decimal(0);
  let unratedHours = new Prisma.Decimal(0);
  let totalAmount = new Prisma.Decimal(0);

  const byTicket = new Map<string, AttestationWorkItem>();
  const byContributor = new Map<string, { name: string; hours: Prisma.Decimal; entries: number; identityVerifiedEntries: number }>();
  const byApprover = new Map<string, { approver: string; entries: number; identityVerified: boolean }>();

  for (const row of timesheets) {
    const hours = new Prisma.Decimal(row.totalHours);
    totalHours = totalHours.add(hours);
    if (row.billable) billableHours = billableHours.add(hours);

    const amount = row.billedAmount != null ? new Prisma.Decimal(row.billedAmount) : null;
    if (row.billable && amount == null) unratedHours = unratedHours.add(hours);
    if (amount != null) totalAmount = totalAmount.add(amount);

    const identityVerified = submitterVerified.has(row.id);

    const entry: AttestationEntry = {
      workDate: toIsoDate(row.workDate),
      hours: Number(hours),
      activityType: row.activityType,
      // Task descriptions are rich text; an attestation is a plain document, and stripping markup
      // also removes any embedded markup a reader's viewer might try to render.
      task: htmlToText(row.taskDescription).slice(0, 500),
      person: row.user.name,
      rate: row.billedRate != null ? Number(row.billedRate) : null,
      rateSource: row.billedRateSource,
      amount: amount != null ? Number(amount) : null,
      identityVerified
    };

    const key = row.ticket?.key ?? "__unticketed__";
    if (!byTicket.has(key)) {
      byTicket.set(key, {
        ticketKey: row.ticket?.key ?? null,
        // Work logged without a ticket is shown, not dropped — hiding it would understate the
        // hours the client is being asked to accept.
        ticketTitle: row.ticket?.title ?? "Unticketed work",
        hours: 0,
        amount: 0,
        entries: []
      });
    }
    const item = byTicket.get(key)!;
    item.entries.push(entry);
    item.hours = Number(new Prisma.Decimal(item.hours).add(hours));
    if (amount != null) item.amount = Number(new Prisma.Decimal(item.amount).add(amount));

    const contributor = byContributor.get(row.user.id) ?? { name: row.user.name, hours: new Prisma.Decimal(0), entries: 0, identityVerifiedEntries: 0 };
    contributor.hours = contributor.hours.add(hours);
    contributor.entries += 1;
    if (identityVerified) contributor.identityVerifiedEntries += 1;
    byContributor.set(row.user.id, contributor);

    if (row.reviewedById) {
      const existing = byApprover.get(row.reviewedById) ?? {
        approver: reviewerName.get(row.reviewedById) ?? "Unknown",
        entries: 0,
        identityVerified: false
      };
      existing.entries += 1;
      if (approverVerified.has(row.id)) existing.identityVerified = true;
      byApprover.set(row.reviewedById, existing);
    }
  }

  const identityVerifiedEntries = timesheets.filter((t) => submitterVerified.has(t.id)).length;

  const caveats: string[] = [];
  if (Number(unratedHours) > 0) {
    caveats.push(
      `${Number(unratedHours).toFixed(2)} billable hour(s) in this period have no rate on record and are excluded from the total amount. Entries approved before rate snapshotting was enabled are reported this way rather than priced at a rate that may not have applied at the time.`
    );
  }
  if (identityVerifiedEntries < timesheets.length) {
    caveats.push(
      `${identityVerifiedEntries} of ${timesheets.length} entries carry a biometric identity check on submission. The remainder were submitted while identity verification was not required for that person.`
    );
  }
  if (timesheets.length === 0) {
    caveats.push("No approved work was recorded for this project in this period.");
  }

  const payload: AttestationPayload = {
    attestation: {
      reference: params.reference ?? buildReference(project.code, params.periodStart),
      generatedAt: new Date().toISOString(),
      generatedBy: params.generatedByName ?? null,
      project: { code: project.code, name: project.name, clientName: project.clientName },
      period: { start: toIsoDate(params.periodStart), end: toIsoDate(params.periodEnd) },
      currency
    },
    summary: {
      totalHours: Number(totalHours),
      billableHours: Number(billableHours),
      unratedHours: Number(unratedHours),
      totalAmount: Number(totalAmount.toFixed(2)),
      entryCount: timesheets.length,
      contributorCount: byContributor.size,
      identityVerifiedEntries,
      approvedEntries: timesheets.length
    },
    // Highest-value work first — what a reader wants to see at the top of an invoice annex.
    workItems: [...byTicket.values()].sort((a, b) => b.amount - a.amount || b.hours - a.hours),
    contributors: [...byContributor.values()]
      .map((c) => ({ name: c.name, hours: Number(c.hours), entries: c.entries, identityVerifiedEntries: c.identityVerifiedEntries }))
      .sort((a, b) => b.hours - a.hours),
    approvals: [...byApprover.values()],
    caveats
  };

  return {
    payload,
    totals: {
      totalHours,
      billableHours,
      unratedHours,
      totalAmount: new Prisma.Decimal(totalAmount.toFixed(2)),
      entryCount: timesheets.length,
      currency
    }
  };
}
