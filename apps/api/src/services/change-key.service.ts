/**
 * WHAT: the change number people quote — `HICS-TS-20260812-0001`.
 *
 * Project code, the UTC date it was raised, and a sequence that restarts each day within each
 * project. Generated here and nowhere else; the API never accepts one from a client.
 *
 * WHY IT IS NOT THE UNDERLYING TICKET'S KEY: a change request is a ticket underneath, but the
 * number goes into approval mail, audit exports and change calendars, where `HICS-OPS-1347` reads
 * as a bug report. The date in the middle is the point — somebody scanning a year of approvals can
 * see when each was raised without opening anything.
 *
 * WHY A COUNT-AND-RETRY RATHER THAN A COUNTER COLUMN: `Project.ticketSeq` exists because ticket keys
 * are allocated constantly and a hot row is worth it. Changes are raised a handful of times a day
 * per project, so a per-day count is cheap, and the UNIQUE index on `changeKey` is what actually
 * guarantees correctness — two people submitting in the same millisecond means one retry, not a
 * duplicate. The alternative, a second sequence column per project per day, is a table that grows
 * forever to save a query nobody runs often.
 */
import type { Prisma } from "@prisma/client";
import { AppError } from "../middleware/error.js";

/** How many times to re-count after losing a race. Three is generous: each retry only loses to
 *  another change raised in the same project on the same day within the same instant. */
const MAX_ATTEMPTS = 3;

/** `20260812` in UTC. UTC throughout, matching every other date bucket in this codebase — a
 *  local-time boundary would give two people in different offices different numbers for the same
 *  moment. */
export function changeKeyDatePart(now = new Date()): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
}

export function formatChangeKey(projectCode: string, datePart: string, sequence: number): string {
  return `${projectCode}-${datePart}-${String(sequence).padStart(4, "0")}`;
}

/**
 * Allocates the next key for a project.
 *
 * Runs inside the caller's transaction so the key and the row it belongs to are written together —
 * a key handed out and then not used would leave a hole in the day's sequence, which is exactly the
 * kind of gap an auditor asks about.
 */
export async function issueChangeKey(tx: Prisma.TransactionClient, projectId: string, now = new Date()): Promise<string> {
  const project = await tx.project.findFirst({ where: { id: projectId }, select: { code: true } });
  if (!project?.code) throw new AppError(422, "That project has no code, so a change number cannot be issued for it.");

  const datePart = changeKeyDatePart(now);
  const prefix = `${project.code}-${datePart}-`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Counted from the KEY PREFIX rather than from createdAt: a change created just before midnight
    // and a re-numbering are both edge cases the prefix handles and a timestamp range does not.
    const used = await tx.changeRequest.count({ where: { changeKey: { startsWith: prefix } } });
    const candidate = formatChangeKey(project.code, datePart, used + 1 + attempt);
    const clash = await tx.changeRequest.findFirst({ where: { changeKey: candidate }, select: { id: true } });
    if (!clash) return candidate;
  }

  // Refused rather than silently numbered out of sequence. Reaching this means three collisions in
  // a row on one project on one day, which is a bug worth hearing about rather than papering over.
  throw new AppError(409, "Could not allocate a change number — please try again.");
}
