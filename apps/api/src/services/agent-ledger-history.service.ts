/**
 * WHAT: the agent ledger over time — every entry in a window, and the same data bucketed per day.
 *
 * WHY IT IS NOT PART OF `agent-ledger.service.ts`: that file owns the WRITE side (`recordAgentWork`,
 * the median baseline) plus one aggregate read, and the aggregate is what the strip on the roster page
 * needs. This is the other question — "is it going up" — which needs rows and days rather than totals,
 * and bolting a second shape onto the summariser would make one function answer two questions badly.
 *
 * WHY THE DAYS ARE ZERO-FILLED AND THE MEASURED ONES ARE COUNTED: a day with no agent work must appear
 * as 0 and not as a gap, or a chart silently changes what its own spacing means. And displacement is
 * only known for some entries — `measuredDays` is returned so the trend is never read as covering the
 * whole window, which is the same "unavailable is never 0" rule the dashboard widgets follow.
 *
 * WHO CALLS THIS: `controllers/agent.controller.ts`.
 */
import { prisma } from "../config/prisma.js";
import { findCapability } from "./ai-capability.registry.js";

export interface LedgerHistory {
  entries: Array<{
    agentRunId: string;
    capability: string;
    title: string;
    costUsd: number;
    durationSeconds: number;
    displacedMinutes: number | null;
    displacedBasis: string | null;
    occurredAt: Date;
  }>;
  /** Day by day, zero-filled. A day with no agent work must appear as 0 and not as a gap, or a chart
   *  silently changes what its own spacing means. */
  daily: Array<{ day: string; costUsd: number; displacedMinutes: number; entries: number }>;
  /** How many of the days in the window have a measured displacement. Reported because the trend line
   *  is otherwise read as covering the whole window. */
  measuredDays: number;
}

const isoDay = (at: Date) =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;

export async function getLedgerHistory(days: number): Promise<LedgerHistory> {
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - (days - 1));

  const rows = await prisma.agentWorkEntry.findMany({
    where: { occurredAt: { gte: from } },
    orderBy: { occurredAt: "desc" },
    take: 500,
    select: {
      agentRunId: true,
      capability: true,
      costUsd: true,
      durationSeconds: true,
      displacedMinutes: true,
      displacedBasis: true,
      occurredAt: true
    }
  });

  const buckets = new Map<string, { costUsd: number; displacedMinutes: number; entries: number }>();
  for (let i = 0; i < days; i += 1) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    buckets.set(isoDay(day), { costUsd: 0, displacedMinutes: 0, entries: 0 });
  }
  const measured = new Set<string>();
  for (const row of rows) {
    const key = isoDay(row.occurredAt);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.costUsd += Number(row.costUsd);
    bucket.entries += 1;
    if (row.displacedMinutes != null) {
      bucket.displacedMinutes += row.displacedMinutes;
      measured.add(key);
    }
  }

  return {
    entries: rows.map((row) => ({
      agentRunId: row.agentRunId,
      capability: row.capability,
      title: findCapability(row.capability)?.title ?? row.capability,
      costUsd: Number(row.costUsd),
      durationSeconds: row.durationSeconds,
      displacedMinutes: row.displacedMinutes,
      displacedBasis: row.displacedBasis,
      occurredAt: row.occurredAt
    })),
    daily: [...buckets.entries()].map(([day, v]) => ({ day, ...v, costUsd: Number(v.costUsd.toFixed(4)) })),
    measuredDays: measured.size
  };
}
