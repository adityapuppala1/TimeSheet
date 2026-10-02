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
 * (active role), who can open the tab they are linked to. Kept separate from face.service.ts so a
 * test that mocks the face service wholesale still exercises the real audience and links.
 */
import { prisma } from "../config/prisma.js";

/** The face verification tab — its review log is where every flagged attempt is decided. */
export const FACE_REVIEW_LINK = "/app/settings?tab=face-verification";
/** The billing tab — the entitlement notice's only remedy is a plan change. */
export const FACE_BILLING_LINK = "/app/settings?tab=billing";

/** Everyone who can open Workspace Settings: active super admins. */
export async function identityAlertRecipients(): Promise<Array<{ id: string; name: string }>> {
  return prisma.user.findMany({
    where: { role: { name: "SUPER_ADMIN" }, status: "ACTIVE", deletedAt: null },
    select: { id: true, name: true }
  });
}
