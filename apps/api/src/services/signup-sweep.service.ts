/**
 * WHAT: removes a self-serve workspace left in PROVISIONING by a signup that never finished — the
 * same cleanup /complete's own failure path does (signup.controller.ts): the Organization row goes,
 * and its company-domain claim with it (ON DELETE CASCADE), so the company can sign up again.
 *
 * WHY IT IS NEEDED. /complete commits the workspace row and claim, spends the continuation, and only
 * then provisions; the cleanup lives in that request's `catch`. A pod killed in between — a deploy, an
 * autoscaler scale-down — never reaches the catch. The row stayed PROVISIONING forever, holding the
 * slug and the company's domain, and /signup told the owner and every colleague after them "your
 * company's workspace is unavailable", with nothing anybody could do about it but email support.
 *
 * WHY 30 MINUTES. Provisioning creates a database, runs every tenant migration and seeds it — tens of
 * seconds, a few minutes on a slow database server — inside one synchronous HTTP request, which any
 * proxy in front of the API times out long before half an hour. A row older than that has no request
 * left that could finish it. Waiting longer only keeps a company locked out for longer.
 *
 * WHAT IT NEVER TOUCHES. A console-created workspace sits in PROVISIONING until an operator presses
 * Provision, for as long as they like; only `createdVia: "SELF_SERVE"` is swept. The physical
 * database, if one got that far, is left for an operator, exactly as the failure path leaves it —
 * dropping a database automatically from a background job is how the wrong one gets dropped.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { companyDomainOf } from "../utils/company-domain.js";
import { platformAudit } from "./platform-audit.service.js";
import { recordSignupStage } from "./signup-funnel.service.js";

export const STALE_PROVISIONING_MINUTES = 30;

export async function sweepAbandonedSignups(now: Date = new Date()): Promise<{ removed: string[] }> {
  const stale = await controlPrisma.organization.findMany({
    where: { status: "PROVISIONING", createdVia: "SELF_SERVE", createdAt: { lt: new Date(now.getTime() - STALE_PROVISIONING_MINUTES * 60_000) } },
    select: { id: true, slug: true, name: true, ownerEmail: true, createdAt: true }
  });

  const removed: string[] = [];
  for (const org of stale) {
    // Conditional on still being PROVISIONING: a signup that finished between the read and here is a
    // customer's live workspace now.
    const { count } = await controlPrisma.organization.deleteMany({ where: { id: org.id, status: "PROVISIONING" } });
    if (count === 0) continue;
    removed.push(org.slug);
    const minutesStuck = Math.round((now.getTime() - org.createdAt.getTime()) / 60_000);
    const detail = `Interrupted mid-provisioning; removed after ${minutesStuck} minutes so the company can sign up again.`;
    await platformAudit("SYSTEM", "scheduler", "org.signup_abandoned", "Organization", org.id, {
      slug: org.slug,
      workspaceName: org.name,
      domain: org.ownerEmail ? companyDomainOf(org.ownerEmail) : null,
      minutesStuck
    });
    // Counted as the failure it was, in the funnel and tomorrow's signup summary.
    await recordSignupStage("FAILED", { email: org.ownerEmail ?? undefined, detail });
  }
  return { removed };
}
