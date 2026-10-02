/**
 * Small decisions the platform console makes that have to agree with the server, kept as plain
 * functions so they can be tested without rendering a page.
 *
 * NONE OF THIS IS THE AUTHORIZATION. The API decides; these only decide what the console shows
 * while it waits to be told.
 */
import type { OrgStatus } from "../services/platform-admin-api";

/** An account-level gate: something the operator must put right about their OWN account before the
 *  console admits them anywhere else. The server enforces it (middleware/platform-admin-auth.ts). */
export type ConsoleAccountGate = "rotation" | "mfa" | null;

/** The 403 `code` the API answers a gated request with, as the gate it means. (A switch rather than
 *  a lookup object: sonarjs reads a `PASSWORD_…` key with a string value as a hard-coded password.) */
function gateForCode(code: string): ConsoleAccountGate {
  switch (code) {
    case "PASSWORD_ROTATION_REQUIRED":
      return "rotation";
    case "MFA_ENROLMENT_REQUIRED":
      return "mfa";
    default:
      return null;
  }
}

interface AccountFlags {
  mustChangePassword?: boolean;
  mfaEnrolmentRequired?: boolean;
  mfaEnabled?: boolean;
}

/**
 * Which gate the signed-in operator is behind, from what `/auth/me` and sign-in report. The
 * password comes first, exactly as on the server: a factor enrolled on top of a password somebody
 * else issued is bound to whoever saw that password.
 */
export function consoleAccountGate(admin: AccountFlags | undefined): ConsoleAccountGate {
  if (admin?.mustChangePassword) return "rotation";
  if (admin?.mfaEnrolmentRequired) return "mfa";
  return null;
}

/**
 * The gate a failed request was refused by, or null. Lets the console react to a gate the store did
 * not know about yet — a password flag set by somebody else while this tab was open — by re-reading
 * the account instead of showing a raw 403 on every card.
 */
export function accountGateFromError(error: unknown): ConsoleAccountGate {
  const response = (error as { response?: { status?: number; data?: { code?: unknown } } } | null)?.response;
  if (response?.status !== 403) return null;
  const code = response.data?.code;
  return typeof code === "string" ? gateForCode(code) : null;
}

/**
 * Whether a console write came back QUEUED (HTTP 202, the two-person rule) rather than done. The
 * queue's answer carries `pending: true` and a request id; a completed result never does. Pages
 * that used to read every 2xx as "done" told an operator a restore or a deletion had happened when
 * it was only waiting for a second owner.
 */
export function isQueuedForApproval(result: unknown): result is { pending: true; requestId: string; message: string } {
  return typeof result === "object" && result !== null && (result as { pending?: unknown }).pending === true && typeof (result as { requestId?: unknown }).requestId === "string";
}

/**
 * The temporary password an approval just issued, if it issued one — creating an operator, or
 * reactivating one. The server returns it to the APPROVER once and keeps only a hash; the approvals
 * page used to show a toast and throw it away, which left every new operator account unusable.
 */
export function issuedCredentialOf(approval: { action: string; result: unknown }): { email: string; name?: string; temporaryPassword: string } | null {
  const result = approval.result as { email?: unknown; name?: unknown; temporaryPassword?: unknown } | null;
  if (!result || typeof result.temporaryPassword !== "string" || typeof result.email !== "string") return null;
  return { email: result.email, ...(typeof result.name === "string" ? { name: result.name } : {}), temporaryPassword: result.temporaryPassword };
}

/** The policy form's own labels (pages/platform-admin/Retention.tsx), so the approver reads the
 *  same words the requester edited. */
const RETENTION_FIELD_LABEL: Record<string, string> = {
  retentionDays: "Retention window",
  autoDeleteEnabled: "Auto-delete after the window",
  reminderDays: "Reminder days after the trial ends",
  feedbackDay: "Check-in on trial day",
  snapshotDir: "Snapshot directory",
  enabled: "Programme"
};

function retentionValue(field: string, value: unknown): string {
  if (field === "snapshotDir") return typeof value === "string" && value.trim() ? value : "none — no snapshot is kept";
  if (field === "enabled") return value ? "on" : "paused";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.join(", ");
  if (field === "retentionDays") return `${String(value)} days`;
  return String(value ?? "—");
}

/**
 * What a queued retention-policy change does, as its approver has to read it (R1-3): each field it
 * changes, old → new, and the server's sentences for what that loosens. Null for any other action,
 * and for a request that does not record its changes (raised by an earlier version — the server
 * refuses to apply those). The card used to show only a label and the requester's own words, so a
 * benign-sounding reason could hide "auto-delete on, window 90 → 7 days".
 */
export function retentionApprovalOf(row: { action: string; body: unknown }): { changes: { label: string; from: string; to: string }[]; risks: string[] } | null {
  if (row.action !== "retention.settings") return null;
  const body = row.body as { changes?: unknown; risks?: unknown } | null;
  if (!body || typeof body.changes !== "object" || body.changes === null) return null;
  return {
    changes: Object.entries(body.changes as Record<string, { from?: unknown; to?: unknown } | null>).map(([field, change]) => ({
      label: RETENTION_FIELD_LABEL[field] ?? field,
      from: retentionValue(field, change?.from),
      to: retentionValue(field, change?.to)
    })),
    risks: Array.isArray(body.risks) ? body.risks.filter((risk): risk is string => typeof risk === "string") : []
  };
}

/**
 * How many workspaces are really in the retention programme: ones that had a trial and have NOT
 * converted. `plan.converted` is the server's isConverted (retention.service.ts); counting
 * `inProgramme` alone included paying customers who merely started as trials. Same rule as the
 * Overview's "In retention" figure, which the server computes.
 */
export function countInRetention(queue: ReadonlyArray<{ plan: { inProgramme: boolean; converted: boolean } }>): number {
  return queue.filter((row) => row.plan.inProgramme && !row.plan.converted).length;
}

/**
 * Whether the console-wide "set up two-factor" banner applies: an operator with no factor whom the
 * deployment does NOT force to enrol (a role it does not cover, or PLATFORM_ADMIN_REQUIRE_MFA off).
 * Quiet behind a gate, because the gate's own screen is already saying it.
 */
export function shouldNagForMfa(admin: AccountFlags | undefined): boolean {
  if (!admin || admin.mfaEnabled) return false;
  return consoleAccountGate(admin) === null;
}

/**
 * The statuses the organization dialog offers, in order. PROVISIONING only to a workspace that is
 * still in it: the API refuses a move back INTO it (the signup sweep deletes a self-serve workspace it
 * finds there), and offering it first in the list made it the easiest wrong choice on the page. A
 * provisioning workspace keeps it because the dialog re-sends the status it opened with.
 */
export function orgStatusChoices(current: OrgStatus): OrgStatus[] {
  const settled: OrgStatus[] = ["ACTIVE", "GRACE", "SUSPENDED", "ARCHIVED"];
  return current === "PROVISIONING" ? ["PROVISIONING", ...settled] : settled;
}
