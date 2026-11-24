/**
 * The Organisation tab's numbers (V17 UI v2), as pure functions so the arithmetic, the "—, not 0%"
 * rule and the delta wording are tested without a chart (tests/unit/org-kpis.test.ts).
 *
 * At most four KPIs: attendance, absence, hours against expected, leave utilisation. Each carries a
 * delta against the previous period of the same length (an arrow icon AND words, never colour alone)
 * and, where the API has a daily series, a sparkline.
 */
import type { OrgAnalytics } from "../services/attendance-api";

export interface Kpi {
  id: "attendance" | "absence" | "hours" | "leave";
  label: string;
  /** Display text: "94%", "38.5 / 40h", "—". */
  value: string;
  /** Raw 0–1 (or ratio) figure the delta is computed from; null when there is none. */
  raw: number | null;
  hint: string;
  series: number[] | null;
}

export interface Delta {
  direction: "up" | "down" | "flat";
  text: string;
}

const pct = (r: number | null) => (r == null ? "—" : `${Math.round(r * 100)}%`);

/** Percentage-point change between two rates; null when either side is missing. */
export function deltaPoints(current: number | null, previous: number | null, unit = "pts"): Delta | null {
  if (current == null || previous == null) return null;
  const diff = Math.round((current - previous) * 1000) / 10;
  if (Math.abs(diff) < 0.1) return { direction: "flat", text: "No change" };
  return { direction: diff > 0 ? "up" : "down", text: `${diff > 0 ? "+" : "−"}${Math.abs(diff)} ${unit}` };
}

/** Leave days taken per person-working-day across the range, from the leave utilisation rows. */
export function leaveUtilisation(org: Pick<OrgAnalytics, "leave" | "overall" | "range">): number | null {
  const rows = org.leave?.utilisation;
  const people = org.overall.people;
  if (!rows || org.overall.suppressed || people <= 0 || org.range.workingDays <= 0) return null;
  return rows.reduce((n, r) => n + r.days, 0) / (people * org.range.workingDays);
}

export function orgKpis(org: OrgAnalytics): Kpi[] {
  const a = org.overall.aggregates;
  const hours = org.hours;
  const out: Kpi[] = [
    {
      id: "attendance",
      label: "Attendance",
      value: pct(a?.presenceRate ?? null),
      raw: a?.presenceRate ?? null,
      hint: "Present ÷ (present + absent). Holidays, weekends and approved leave do not count.",
      series: org.trend?.map((t) => t.presenceRate).filter((v): v is number => v != null) ?? null
    },
    {
      id: "absence",
      label: "Absence",
      value: pct(a?.absenceRate ?? null),
      raw: a?.absenceRate ?? null,
      hint: "Working days nobody punched in on, once the day was over.",
      series: org.trend?.map((t) => t.absenceRate).filter((v): v is number => v != null) ?? null
    },
    {
      id: "hours",
      label: "Hours vs expected",
      value: hours ? `${hours.logged} / ${hours.expected}h` : "—",
      raw: hours && hours.expected > 0 ? hours.logged / hours.expected : null,
      hint: "Average hours logged per person, against what was expected after holidays and leave.",
      series: null
    }
  ];
  const leave = leaveUtilisation(org);
  if (org.leave) {
    out.push({
      id: "leave",
      label: "Leave utilisation",
      value: pct(leave),
      raw: leave,
      hint: "Approved leave days as a share of everyone's working days in the range.",
      series: null
    });
  }
  return out.slice(0, 4);
}

/** Observation → evidence → action: the last sentence of a detail is its suggested action. */
export function splitInsightDetail(detail: string): { evidence: string; action: string | null } {
  const sentences = detail.split(/(?<=[.!?]) /).map((s) => s.trim()).filter(Boolean);
  if (sentences.length < 2) return { evidence: detail, action: null };
  return { evidence: sentences.slice(0, -1).join(" "), action: sentences.at(-1) ?? null };
}

/** SVG polyline points for a sparkline in a `w` × `h` box; empty for fewer than two points. */
export function sparklinePoints(values: readonly number[], w: number, h: number, pad = 2): string {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (w - pad * 2);
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
    })
    .join(" ");
}

/** The previous window of the same length, ending the day before `from`. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const day = 86_400_000;
  const len = Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / day) + 1;
  const end = new Date(new Date(`${from}T12:00:00Z`).getTime() - day);
  const start = new Date(end.getTime() - (len - 1) * day);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}
