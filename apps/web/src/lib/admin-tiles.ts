/**
 * WHAT: the stat tiles the home page (admins and managers) and the Reports page build from
 * `GET /reports/admin-summary`, as plain data — so what each tile claims can be tested.
 *
 * WHY THESE RULES (each was a bug):
 *   - A POINT-IN-TIME figure — users, projects, pending approvals, open escalations, the security
 *     risk score — is labelled "now" and carries NO delta. Each used to be compared with "those that
 *     already existed before the period", a number that is a subset of the current one, so the badge
 *     could only ever point up.
 *   - A PERIOD figure carries its like-for-like comparison and the comparison's label, printed.
 *   - A figure that did not load is "—", never 0. The security risk score read `?? 0` and was toned
 *     "success" — a failed request rendered as a clean bill of health.
 */
import type { AdminSummary } from "../services/api";
import { formatHours, formatNumber, NO_VALUE } from "./format";
import { computeTrend, type Trend } from "./trend";

export type TileTone = "default" | "success" | "warning" | "destructive";

export interface Tile {
  label: string;
  value: string;
  tone?: TileTone;
  trend?: Trend | null;
  trendLabel?: string;
  /** What the figure includes, in a sentence — shown under it. */
  hint?: string;
}

/** Thresholds of the security risk score; null (not loaded) is neither good nor bad. */
export function riskTone(score: number | null | undefined): TileTone {
  if (score === null || score === undefined) return "default";
  if (score > 30) return "destructive";
  if (score > 10) return "warning";
  return "success";
}

const count = (n: number | null | undefined) => formatNumber(n ?? null);

/** The home page's admin tile row. `summary` undefined = not loaded; the caller shows the error. */
export function dashboardAdminTiles(
  summary: AdminSummary | undefined,
  riskScore: number | null | undefined,
  context: { periodIn: string; comparisonLabel: string }
): Tile[] {
  return [
    {
      label: "Users · now",
      value: count(summary?.users),
      hint: summary ? `${formatNumber(summary.usersJoined)} joined ${context.periodIn}. People only — no AI agents, no one deactivated.` : undefined
    },
    {
      label: "Projects · now",
      value: count(summary?.projects),
      hint: summary ? `${formatNumber(summary.projectsCreated)} created ${context.periodIn}.` : undefined
    },
    {
      label: "Approved hours",
      value: summary ? formatHours(summary.approvedHours) : NO_VALUE,
      tone: "success",
      trend: summary ? computeTrend(summary.approvedHours, summary.approvedHoursPrev, true) : null,
      trendLabel: context.comparisonLabel,
      hint: `Hours approved on entries dated ${context.periodIn}.`
    },
    {
      label: "Pending approvals · now",
      value: count(summary?.pendingApprovals),
      tone: (summary?.pendingApprovals ?? 0) > 0 ? "warning" : "default"
    },
    {
      label: "Security risk score · now",
      value: riskScore === null || riskScore === undefined ? NO_VALUE : formatNumber(riskScore),
      tone: riskTone(riskScore)
    }
  ];
}

/** The Reports page's tile row. Asked with no range, so its period figures are today / this week. */
export function reportsAdminTiles(summary: AdminSummary | undefined): Tile[] {
  return [
    { label: "Users · now", value: count(summary?.users), hint: summary ? `${formatNumber(summary.usersJoined)} joined today.` : undefined },
    { label: "Projects · now", value: count(summary?.projects), hint: summary ? `${formatNumber(summary.projectsCreated)} created today.` : undefined },
    {
      label: "Pending approvals · now",
      value: count(summary?.pendingApprovals),
      tone: (summary?.pendingApprovals ?? 0) > 0 ? "warning" : "default"
    },
    {
      label: "Approved hours this week",
      value: summary ? formatHours(summary.approvedThisWeek) : NO_VALUE,
      tone: "success",
      trend: summary ? computeTrend(summary.approvedThisWeek, summary.approvedLastWeek, true) : null,
      trendLabel: "vs the same days last week",
      hint: "Monday to today."
    },
    {
      label: "Approval SLA breaches today",
      value: count(summary?.slaBreached),
      tone: (summary?.slaBreached ?? 0) > 0 ? "warning" : "default",
      trend: summary ? computeTrend(summary.slaBreached, summary.slaBreachedPrev, false) : null,
      trendLabel: summary?.period.comparisonLabel,
      hint: "Approval deadlines that fell today and passed before a decision."
    },
    {
      label: "Open escalations · now",
      value: count(summary?.openEscalations),
      tone: (summary?.openEscalations ?? 0) > 0 ? "warning" : "default"
    }
  ];
}
