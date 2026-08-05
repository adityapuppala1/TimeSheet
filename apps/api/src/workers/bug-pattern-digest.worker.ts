/**
 * Monthly "what keeps breaking" digest — cross-references three signals that are each
 * individually visible today (the CI test-run log, a single ticket's own failure count, the
 * security-findings review log) but nobody manually correlates into a trend: recurring CI
 * failures by provider/branch, tickets accumulating the most failed test runs, and
 * security-finding hotspots by repository. Monthly rather than weekly (like
 * security-weekly-digest.worker.ts) because a trend needs a longer window than a week to mean
 * anything — a single bad week is noise, a bad month is a pattern.
 * WHY skip a month with nothing to report: same reasoning every other digest worker here gives —
 * an AI-authored "nothing interesting happened" email erodes trust in the feature.
 */
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { generateBugPatternDigest, getGlobalAISettings } from "../services/ai.service.js";
import { templates } from "../services/mail-templates.js";
import { dispatchNotification } from "../services/notify.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
let running = false;

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 28;

function startOfLocalMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

async function alreadySentThisMonth(monthStart: Date): Promise<boolean> {
  const count = await prisma.notification.count({ where: { category: "digest.bug_pattern", createdAt: { gte: monthStart } } });
  return count > 0;
}

/** Runs the monthly bug-pattern digest for the current tenant, if enabled and there's something
 *  worth reporting. Returns whether it actually sent, for the caller's log line. */
export async function runBugPatternDigest(now: Date = new Date()): Promise<{ sent: boolean; reason?: string }> {
  const aiSettings = await getGlobalAISettings();
  if (!aiSettings.aiEnabled || !aiSettings.bugPatternDigestEnabled) return { sent: false, reason: "disabled" };

  const monthStart = startOfLocalMonth(now);
  if (await alreadySentThisMonth(monthStart)) return { sent: false, reason: "already sent this month" };

  const cutoff = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  const periodLabel = `${cutoff.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${now.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  const [byProviderBranch, byTicket, byRepository] = await Promise.all([
    prisma.testRun.groupBy({
      by: ["provider", "branch"],
      where: { status: "FAILED", createdAt: { gte: cutoff } },
      _count: true,
      orderBy: { _count: { provider: "desc" } },
      take: 5
    }),
    prisma.testRun.groupBy({
      by: ["ticketId"],
      where: { status: "FAILED", ticketId: { not: null }, createdAt: { gte: cutoff } },
      _count: true,
      orderBy: { _count: { ticketId: "desc" } },
      take: 5
    }),
    prisma.securityFinding.groupBy({
      by: ["repository"],
      where: { status: { in: ["OPEN", "ACKNOWLEDGED"] }, repository: { not: null }, createdAt: { gte: cutoff } },
      _count: true,
      orderBy: { _count: { repository: "desc" } },
      take: 5
    })
  ]);

  if (byProviderBranch.length === 0 && byTicket.length === 0 && byRepository.length === 0) {
    return { sent: false, reason: "nothing to report" };
  }

  const ticketIds = byTicket.map((t) => t.ticketId).filter((id): id is string => Boolean(id));
  const tickets = ticketIds.length > 0 ? await prisma.ticket.findMany({ where: { id: { in: ticketIds } }, select: { id: true, key: true, title: true } }) : [];
  const ticketById = new Map(tickets.map((t) => [t.id, t]));

  const admins = await prisma.user.findMany({
    where: { status: "ACTIVE", deletedAt: null, role: { name: { in: ["ADMIN", "SUPER_ADMIN"] } } },
    select: { id: true }
  });
  if (admins.length === 0) return { sent: false, reason: "no admins" };

  let summary: string;
  try {
    const result = await generateBugPatternDigest({
      periodLabel,
      recurringFailures: byProviderBranch.map((f) => ({ provider: f.provider, branch: f.branch, count: f._count })),
      hotTickets: byTicket
        .map((t) => {
          const ticket = t.ticketId ? ticketById.get(t.ticketId) : undefined;
          return ticket ? { key: ticket.key, title: ticket.title, failureCount: t._count } : null;
        })
        .filter((t): t is { key: string; title: string; failureCount: number } => t !== null),
      findingHotspots: byRepository.map((f) => ({ repository: f.repository ?? "Unknown", count: f._count }))
    });
    summary = result.summary;
  } catch (error) {
    console.error("[bug-pattern-digest] AI generation failed:", (error as Error).message);
    return { sent: false, reason: "AI generation failed" };
  }
  if (!summary) return { sent: false, reason: "empty summary" };

  for (const admin of admins) {
    await dispatchNotification({
      userId: admin.id,
      category: "digest.bug_pattern",
      title: `What kept breaking — ${periodLabel}`,
      body: summary,
      link: "/app/tickets",
      email: {
        templateKey: "digest.bug_pattern",
        vars: { periodLabel, summary },
        fallback: {
          subject: `What kept breaking — ${periodLabel}`,
          html: templates.bugPatternDigest({ periodLabel, summary })
        }
      }
    });
  }

  return { sent: true };
}

export function startBugPatternDigestWorker() {
  if (started) return;
  started = true;

  // 09:00 on the 1st of every month, server-local time.
  cron.schedule("0 9 1 * *", () => {
    if (running) return;
    running = true;
    runForEveryOrg("bug-pattern-digest", async () => {
      const result = await runBugPatternDigest();
      if (result.sent) console.info("[bug-pattern-digest] sent.");
    })
      .catch((error) => console.error("[bug-pattern-digest] run failed:", (error as Error).message))
      .finally(() => {
        running = false;
      });
  });

  console.info("[bug-pattern-digest] worker scheduled (monthly, 1st @ 09:00).");
}
