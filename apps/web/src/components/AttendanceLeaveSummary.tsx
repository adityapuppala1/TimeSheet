/**
 * 7.0.0 — "Attendance & leave" on the Reports page: per person, over a chosen range, the working
 * days, holidays, leave days by type, present and absent days and logged hours, with a CSV export.
 *
 * The figures are the server's (GET /attendance/day-grid, which judges every day with the shared
 * resolver), so this card can never disagree with Team Activity or the Home grid. It renders
 * NOTHING when the module is off or not in the plan: the endpoint then answers `{ enabled: false }`.
 *
 * k-anonymity: none. The existing per-person report tables on this page (utilisation, the
 * timesheet report) name people without a minimum group size, and only the aggregate attendance
 * analytics apply one; a named per-person table has nothing to anonymise.
 *
 * Mobile: a table from md up; below that, one compact card per person — never a dense table.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { CalendarRange, Download } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { DateRangePicker, type DateRangeValue } from "./ui/date-range-picker";
import { Skeleton } from "./ui/skeleton";
import { QueryError } from "./QueryState";
import { attendanceApi, type DayGridResponse } from "../services/attendance-api";
import { downloadText, toCsv } from "../lib/csv-export";
import { STATUS_META } from "../lib/attendance-status";
import { localDateKey } from "../lib/local-day";
import { cn } from "../lib/utils";

/** The 1st of this month to today — the default window. */
function thisMonthRange(now = new Date()): DateRangeValue {
  return { from: localDateKey(new Date(now.getFullYear(), now.getMonth(), 1)), to: localDateKey(now) };
}

type EnabledGrid = Extract<DayGridResponse, { enabled: true }>;

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** The CSV rows: one per person, one column per leave type in use. Exported for the unit test. */
export function attendanceSummaryCsv(data: EnabledGrid): string {
  const types = data.leaveTypes;
  const headers = [
    "Person",
    "Working days",
    "Holidays",
    ...types.map((t) => `Leave: ${t.name} (${t.code})`),
    "Leave days (total)",
    ...(data.attendanceEnabled ? ["Present days", "Absent days"] : []),
    "Logged hours"
  ];
  const rows = data.people.map((p) => {
    const leaveTotal = Object.values(p.summary.leaveDays).reduce((a, b) => a + b, 0);
    return [
      p.name,
      p.summary.workingDays,
      p.summary.holidays,
      ...types.map((t) => p.summary.leaveDays[t.code] ?? 0),
      leaveTotal,
      ...(data.attendanceEnabled ? [p.summary.presentDays, p.summary.absentDays] : []),
      p.summary.loggedHours
    ];
  });
  return toCsv(headers, rows);
}

function Chip({ status, text }: { status: "PRESENT" | "ABSENT" | "LEAVE" | "HOLIDAY"; text: string }) {
  const meta = STATUS_META[status];
  return (
    <span className={cn("status-chip inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums", meta.className)}>
      <meta.icon className="h-3 w-3" aria-hidden />
      {text}
    </span>
  );
}

export function AttendanceLeaveSummary() {
  const [range, setRange] = useState<DateRangeValue>(thisMonthRange);
  const valid = Boolean(range.from && range.to);
  const q = useQuery({
    queryKey: ["attendance", "day-grid", range.from, range.to],
    queryFn: () => attendanceApi.dayGrid(range.from, range.to),
    enabled: valid,
    staleTime: 60_000,
    retry: false,
    placeholderData: (prev) => prev
  });

  // Module off / not entitled / not loaded yet: the section does not exist, not even as a skeleton,
  // so with the module off the page is exactly what it was. The previous range's data is kept while
  // a new range loads (placeholderData), so changing the range never makes the card vanish.
  if (!q.data?.enabled) return null;

  const data = q.data?.enabled ? q.data : undefined;
  const types = data?.leaveTypes ?? [];
  const showAttendance = Boolean(data?.attendanceEnabled);

  return (
    <Card data-testid="attendance-leave-summary">
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarRange className="h-4 w-4 text-primary" />
            Attendance &amp; leave
          </CardTitle>
          <CardDescription>
            Per person for the selected range: working days (holidays excluded), holidays, approved leave by type
            {showAttendance ? ", days present and absent" : ""} and hours logged. A half day of leave counts 0.5.
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangePicker id="attendance-summary-range" value={range} onChange={setRange} allowAllTime={false} className="w-60" />
          <Button
            size="sm"
            variant="outline"
            className="h-9"
            disabled={!data || data.people.length === 0}
            onClick={() => data && downloadText(`attendance-leave-${data.from}-to-${data.to}.csv`, attendanceSummaryCsv(data))}
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {q.isFetching && q.isPlaceholderData && <Skeleton className="mb-2 h-1 w-full" />}
        {q.isError && <QueryError what="the attendance & leave summary" onRetry={() => q.refetch()} compact />}
        {data && data.people.length === 0 && <p className="text-sm text-muted-foreground">Nobody is in scope for this range.</p>}
        {data && data.people.length > 0 && (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Person</th>
                    <th className="px-3 py-2 text-right font-medium">Working days</th>
                    <th className="px-3 py-2 text-right font-medium">Holidays</th>
                    {types.map((t) => (
                      <th key={t.code} className="px-3 py-2 text-right font-medium" title={t.name}>
                        Leave · {t.code}
                      </th>
                    ))}
                    {types.length === 0 && <th className="px-3 py-2 text-right font-medium">Leave</th>}
                    {showAttendance && <th className="px-3 py-2 text-right font-medium">Present</th>}
                    {showAttendance && <th className="px-3 py-2 text-right font-medium">Absent</th>}
                    <th className="px-3 py-2 text-right font-medium">Logged hours</th>
                  </tr>
                </thead>
                <tbody>
                  {data.people.map((p) => (
                    <tr key={p.userId} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-2 font-medium">{p.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{p.summary.workingDays}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{p.summary.holidays}</td>
                      {types.map((t) => (
                        <td key={t.code} className="px-3 py-2 text-right tabular-nums">
                          {num(p.summary.leaveDays[t.code] ?? 0)}
                        </td>
                      ))}
                      {types.length === 0 && <td className="px-3 py-2 text-right tabular-nums">0</td>}
                      {showAttendance && <td className="px-3 py-2 text-right tabular-nums">{p.summary.presentDays}</td>}
                      {showAttendance && <td className="px-3 py-2 text-right tabular-nums">{p.summary.absentDays}</td>}
                      <td className="px-3 py-2 text-right tabular-nums">{p.summary.loggedHours.toFixed(1)}h</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="grid gap-2 md:hidden">
              {data.people.map((p) => {
                const leaveTotal = Object.values(p.summary.leaveDays).reduce((a, b) => a + b, 0);
                return (
                  <li key={p.userId} className="rounded-lg border border-border p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="min-w-0 truncate text-sm font-semibold">{p.name}</p>
                      <p className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {p.summary.loggedHours.toFixed(1)}h · {p.summary.workingDays} working days
                      </p>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {showAttendance && <Chip status="PRESENT" text={`${p.summary.presentDays} present`} />}
                      {showAttendance && <Chip status="ABSENT" text={`${p.summary.absentDays} absent`} />}
                      <Chip
                        status="LEAVE"
                        text={
                          leaveTotal > 0
                            ? Object.entries(p.summary.leaveDays)
                                .map(([code, n]) => `${num(n)} ${code}`)
                                .join(" · ")
                            : "0 leave"
                        }
                      />
                      <Chip status="HOLIDAY" text={`${p.summary.holidays} ${p.summary.holidays === 1 ? "holiday" : "holidays"}`} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
