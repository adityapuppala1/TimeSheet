/**
 * WHAT: the weekly nudge that keeps goals from becoming a page nobody opens.
 *
 * WHY IT EXISTS AT ALL: V8 shipped Goals with measured progress and no notification of any kind. The
 * ordinary failure of OKRs is not that the numbers are wrong — it is that nobody looks at them again
 * after the quarter starts, and a goal whose progress reports itself is exactly the kind of thing it is
 * easy to stop looking at. So once a week, the person who OWNS a goal hears where it stands.
 *
 * WHY IT ONLY WRITES TO THE OWNER: a goal is somebody's commitment. Telling a whole workspace that a
 * number is off track is a management decision, not a notification default, and the workspace can
 * already see every goal on the page.
 *
 * WHY ONE MESSAGE PER PERSON RATHER THAN PER GOAL: a send per goal is the send people filter, and
 * filtering it costs them the one that mattered. The same argument the other digests in this directory
 * make.
 *
 * WHY IT SAYS NOTHING WHEN THERE IS NOTHING TO SAY: a goal that is on track with time left is not news.
 * A digest that arrives every week regardless teaches people it contains nothing.
 */
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { measureGoal, type GoalMeasurement } from "../services/goal-progress.service.js";
import { templates } from "../services/mail-templates.js";
import { dispatchNotification } from "../services/notify.service.js";
import { isPlanningCapabilityAllowed } from "../services/plan-limits.service.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
let running = false;

/** A period closing inside this window is worth mentioning even when the goal is fine — it is the last
 *  moment anybody can still affect the number. */
const CLOSING_SOON_DAYS = 7;

interface GoalLine {
  ownerId: string;
  ownerName: string;
  text: string;
  /** Only a goal with something WRONG or something CLOSING earns a line. */
  urgent: boolean;
}

function describe(goal: { title: string; endDate: Date | null }, measurement: GoalMeasurement, now: Date): GoalLine["text"] | null {
  if (measurement.unavailable) {
    // Said plainly rather than skipped: "we cannot measure this yet" is information the owner can act
    // on — usually by linking the goal to something.
    return `${goal.title} — not measurable yet: ${measurement.unavailableReason ?? "nothing comparable to measure against"}`;
  }

  const closingInDays = goal.endDate ? Math.ceil((goal.endDate.getTime() - now.getTime()) / 86_400_000) : null;
  const closing = closingInDays !== null && closingInDays >= 0 && closingInDays <= CLOSING_SOON_DAYS;

  if (measurement.health === "OFF_TRACK" || measurement.health === "AT_RISK") {
    const state = measurement.health === "OFF_TRACK" ? "off track" : "at risk";
    const pct = measurement.progressPct === null ? "" : `, ${measurement.progressPct}% of the way`;
    const when = closing ? ` and the period ends in ${closingInDays} day${closingInDays === 1 ? "" : "s"}` : "";
    return `${goal.title} — ${state}${pct}${when}`;
  }
  if (closing) {
    return `${goal.title} — on track, and the period ends in ${closingInDays} day${closingInDays === 1 ? "" : "s"}`;
  }
  return null;
}

/** One workspace's digest. Exported for its own test — the interesting part is WHICH goals earn a line,
 *  and that is decidable without a scheduler. */
export async function sendGoalDigests(now: Date = new Date()): Promise<number> {
  // Same two-layer gating every digest here uses: the workspace's plan decides whether the feature
  // exists, the per-category toggle decides whether email leaves. `dispatchNotification` applies the
  // second; this applies the first, so a workspace without Goals gets no in-app rows either.
  if (!(await isPlanningCapabilityAllowed(requireTenantContext().orgId, "goalsEnabled"))) return 0;

  const goals = await prisma.goal.findMany({
    where: { deletedAt: null, status: "ACTIVE", ownerId: { not: null } },
    select: {
      id: true,
      title: true,
      ownerId: true,
      progressSource: true,
      startDate: true,
      endDate: true,
      targetValue: true,
      manualProgressPct: true,
      owner: { select: { id: true, name: true, status: true, deletedAt: true, isAgent: true } }
    }
  });

  const byOwner = new Map<string, GoalLine[]>();
  for (const goal of goals) {
    // An owner who has left, or an agent identity that cannot read mail, is not somebody to write to.
    if (!goal.owner || goal.owner.deletedAt || goal.owner.status !== "ACTIVE" || goal.owner.isAgent) continue;

    const measurement = await measureGoal(goal, now);
    const text = describe(goal, measurement, now);
    if (!text) continue;

    const lines = byOwner.get(goal.owner.id) ?? [];
    lines.push({ ownerId: goal.owner.id, ownerName: goal.owner.name, text, urgent: true });
    byOwner.set(goal.owner.id, lines);
  }

  const weekLabel = `${now.toISOString().slice(0, 10)}`;
  let sent = 0;
  for (const [ownerId, lines] of byOwner) {
    const name = lines[0].ownerName;
    const summary =
      lines.length === 1
        ? "One of your goals needs a look this week."
        : `${lines.length} of your goals need a look this week.`;

    await dispatchNotification({
      userId: ownerId,
      category: "goal.digest",
      title: summary,
      body: lines.map((l) => l.text).join(" · ").slice(0, 500),
      link: "/app/goals",
      email: {
        templateKey: "goal.digest",
        vars: { name, weekLabel, summary, linesText: lines.map((l) => l.text).join("<br />") },
        fallback: {
          subject: `Your goals — ${weekLabel}`,
          html: templates.goalDigest({ name, weekLabel, summary, lines: lines.map((l) => l.text) })
        }
      }
    });
    sent += 1;
  }
  return sent;
}

export function startGoalDigestWorker(): void {
  if (started) return;
  started = true;

  // Monday 08:00, matching the other weekly digests — one arrival, not four across the week.
  cron.schedule("0 8 * * 1", async () => {
    if (running) return;
    running = true;
    try {
      await runForEveryOrg("goal-digest", async () => {
        const sent = await sendGoalDigests();
        if (sent > 0) console.log(`[goal-digest] ${sent} digest(s) sent`);
      });
    } catch (error) {
      console.warn(`[goal-digest] tick failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  });
}
