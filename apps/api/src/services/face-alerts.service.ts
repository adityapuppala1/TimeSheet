/**
 * WHAT: who receives face/identity alerts, and where they link.
 *
 * WHY THIS IS ITS OWN FILE: four producers (the flagged-check alert in face.controller.ts, the
 * entitlement and review-overdue notices in face-retention.worker.ts, and the weekly identity digest)
 * each picked their own audience and their own link, and all four picked wrongly the same way: every
 * ADMIN (plus, for a flagged check, the person's manager), sent to a bare `/app/settings`. Workspace
 * Settings is SUPER_ADMIN-only (App.tsx RequireRole) — so ADMINs and managers clicking through landed
 * on the home page with no route to the review log, and a super admin landed on the Reminders tab,
 * the page's default, rather than the log.
 *
 * THE CHOICE, and why not the alternative: the API does let ADMIN review attempts, so exposing the
 * review log to ADMIN in the UI was considered. It would mean loosening a page that is documented and
 * gated as SUPER_ADMIN-only in three places (route, nav, settings API), whose face card is driven by
 * a super-admin-only settings read — not a clean per-tab gate. So these alerts go to SUPER_ADMIN
 * (active role), who can open the tab they are linked to — falling back to ADMIN only when there is
 * no super admin left to tell (see `identityAlertRecipients`). Kept separate from face.service.ts so a
 * test that mocks the face service wholesale still exercises the real audience and links.
 */
import { prisma } from "../config/prisma.js";

/** The face verification tab — its review log is where every flagged attempt is decided. */
export const FACE_REVIEW_LINK = "/app/settings?tab=face-verification";
/** The billing tab — the entitlement notice's only remedy is a plan change. */
export const FACE_BILLING_LINK = "/app/settings?tab=billing";

/**
 * Who hears about identity alerts: everyone who can open Workspace Settings — the active super
 * admins — less `excludeUserId`, the person a flagged check is about.
 *
 * THE FALLBACK (audit 2026-10 R3, finding 5): when that leaves nobody, the active ADMINs. A flagged
 * check on the workspace's ONLY super admin — somebody at the owner's session failing check after
 * check, or passing through a virtual camera — otherwise alerted an empty list, and a workspace with
 * no active super admin heard about nothing at all. An admin cannot open the review log's tab, but
 * being told an impersonation attempt happened is the point; the record is in the audit log either
 * way, and the subject is never told about their own flag.
 */
export async function identityAlertRecipients(excludeUserId?: string): Promise<Array<{ id: string; name: string }>> {
  const holders = async (role: "SUPER_ADMIN" | "ADMIN") =>
    (
      await prisma.user.findMany({
        where: { role: { name: role }, status: "ACTIVE", deletedAt: null },
        select: { id: true, name: true }
      })
    ).filter((user) => user.id !== excludeUserId);
  const superAdmins = await holders("SUPER_ADMIN");
  return superAdmins.length > 0 ? superAdmins : holders("ADMIN");
}
