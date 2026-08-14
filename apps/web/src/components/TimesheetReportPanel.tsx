/**
 * WHAT: the filterable timesheet report — a filter bar that drives a grouped breakdown and both
 * exports from one place.
 *
 * WHY THE FILTERS AND THE EXPORT BUTTONS SHARE ONE STATE: before this, the two export buttons took
 * no parameters at all. "Export" meant every timesheet in the workspace, for all time, for
 * everybody, and there was no way to ask for one project or one month. Putting the buttons inside
 * the same filter block they obey is what makes "what you see is what you download" true rather
 * than something the user has to take on trust.
 *
 * WHY THE GROUPED VIEW LEADS AND THE EXPORTS FOLLOW: the point of a report is usually a question
 * ("where did Apollo's hours go?"), not a file. Answering it on screen means most people never
 * need the download, and the ones who do have already narrowed it.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileSpreadsheet, Loader2 } from "lucide-react";

import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { DateRangePicker } from "./ui/date-range-picker";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { toast } from "./ui/toaster";
import { activityTypeApi, projectApi, reportApi, userApi, type GroupByKey, type TimesheetReportFilters } from "../services/api";

const ANY = "any";

const GROUP_LABEL: Record<GroupByKey, string> = {
  user: "Person",
  project: "Project",
  module: "Module",
  activity: "Activity",
  status: "Status",
  ticket: "Ticket",
  day: "Day",
  week: "Week",
  month: "Month"
};

/** Turns the form's "any" sentinels into an actual filter set. */
function toFilters(form: {
  from: string;
  to: string;
  projectId: string;
  userId: string;
  status: string;
  activityType: string;
  billable: string;
}): TimesheetReportFilters {
  return {
    from: form.from || undefined,
    to: form.to || undefined,
    projectId: form.projectId === ANY ? undefined : form.projectId,
    userId: form.userId === ANY ? undefined : form.userId,
    status: form.status === ANY ? undefined : (form.status as TimesheetReportFilters["status"]),
    activityType: form.activityType === ANY ? undefined : form.activityType,
    billable: form.billable === ANY ? undefined : form.billable === "true"
  };
}

function hours(n: number): string {
  return `${n.toFixed(2)}h`;
}

export function TimesheetReportPanel() {
  const [form, setForm] = useState({
    from: "",
    to: "",
    projectId: ANY,
    userId: ANY,
    status: ANY,
    activityType: ANY,
    billable: ANY
  });
  const [groupBy, setGroupBy] = useState<GroupByKey>("user");
  const [downloading, setDownloading] = useState<"csv" | "pdf" | "xlsx" | null>(null);

  const filters = toFilters(form);
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list() });
  const users = useQuery({ queryKey: ["users"], queryFn: userApi.list });
  /** The workspace's own activity catalog, not the frozen defaults — otherwise a workspace that
   *  added "Incident response" on the Projects screen could log against it and then never filter
   *  a report by it. */
  const activityTypes = useQuery({ queryKey: ["activity-types"], queryFn: () => activityTypeApi.list() });
  const report = useQuery({
    queryKey: ["reports", "timesheets", filters, groupBy],
    queryFn: () => reportApi.timesheetReport(filters, groupBy),
    placeholderData: (previous) => previous
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function download(type: "csv" | "pdf" | "xlsx") {
    setDownloading(type);
    try {
      // The grouping goes along for xlsx so its Summary sheet matches what is on screen — a
      // workbook whose summary groups differently from the page that produced it is a support
      // ticket waiting to happen.
      const { blob, truncated, rowsIncluded, totalMatching } = await reportApi.download(
        type,
        type === "xlsx" ? { ...filters, groupBy } : filters
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `timesheet-report-${new Date().toISOString().slice(0, 10)}.${type}`;
      anchor.click();
      URL.revokeObjectURL(url);

      if (truncated) {
        // Warned at the moment of download rather than left for the reader to notice inside the
        // file. A partial report that looks complete is the failure this whole change exists to
        // prevent.
        toast.warning(`Downloaded ${rowsIncluded} of ${totalMatching} matching entries`, {
          description: "The file says so too. Narrow the date range for the complete set."
        });
      } else {
        toast.success(`Downloaded ${type.toUpperCase()}`);
      }
    } catch {
      toast.error("Download failed", { description: "Try again, or narrow the filters." });
    } finally {
      setDownloading(null);
    }
  }

  const totals = report.data?.totals;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileSpreadsheet className="h-4 w-4" />
          Timesheet report
        </CardTitle>
        <CardDescription>
          Filter, group and export. What you see here is exactly what the download contains.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {/* One range instead of two unrelated date inputs. Nothing previously stopped `to` being
              before `from`, and "last month" took two taps and a mental calendar. */}
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="report-range">Date range</Label>
            <DateRangePicker
              id="report-range"
              className="w-full"
              value={{ from: form.from, to: form.to }}
              onChange={(range) => setForm((f) => ({ ...f, from: range.from, to: range.to }))}
              placeholder="All time"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="report-project">Project</Label>
            <Select value={form.projectId} onValueChange={(v) => set("projectId", v)}>
              <SelectTrigger id="report-project"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>All projects</SelectItem>
                {(projects.data ?? []).map((p: any) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="report-user">Person</Label>
            <Select value={form.userId} onValueChange={(v) => set("userId", v)}>
              <SelectTrigger id="report-user"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Everyone</SelectItem>
                {(users.data ?? []).map((u: any) => (
                  <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="report-status">Status</Label>
            <Select value={form.status} onValueChange={(v) => set("status", v)}>
              <SelectTrigger id="report-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any status</SelectItem>
                {["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"].map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="report-activity">Activity</Label>
            <Select value={form.activityType} onValueChange={(v) => set("activityType", v)}>
              <SelectTrigger id="report-activity"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any activity</SelectItem>
                {(activityTypes.data ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.name}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="report-billable">Billable</Label>
            <Select value={form.billable} onValueChange={(v) => set("billable", v)}>
              <SelectTrigger id="report-billable"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Either</SelectItem>
                <SelectItem value="true">Billable only</SelectItem>
                <SelectItem value="false">Non-billable only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="report-groupby">Group by</Label>
            <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupByKey)}>
              <SelectTrigger id="report-groupby"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(report.data?.groupByOptions ?? (Object.keys(GROUP_LABEL) as GroupByKey[])).map((key) => (
                  <SelectItem key={key} value={key}>{GROUP_LABEL[key]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={downloading !== null} onClick={() => void download("csv")}>
            {downloading === "csv" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            CSV
          </Button>
          <Button variant="outline" size="sm" disabled={downloading !== null} onClick={() => void download("xlsx")}>
            {downloading === "xlsx" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Excel
          </Button>
          <Button variant="outline" size="sm" disabled={downloading !== null} onClick={() => void download("pdf")}>
            {downloading === "pdf" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            PDF
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setForm({ from: "", to: "", projectId: ANY, userId: ANY, status: ANY, activityType: ANY, billable: ANY })
            }
          >
            Clear filters
          </Button>
        </div>

        {report.isLoading && <Skeleton className="h-40 w-full" />}

        {!report.isLoading && totals && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[
                { label: "Hours", value: hours(totals.hours) },
                { label: "Billable", value: hours(totals.billableHours) },
                { label: "Entries", value: String(totals.entries) },
                {
                  label: "Cost",
                  // Null means no row carried a rate. "—" is the honest rendering; £0.00 would
                  // claim the work was free.
                  value: totals.cost === null ? "—" : totals.cost.toFixed(2)
                }
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-xs uppercase text-muted-foreground">{s.label}</p>
                  <p className="mt-1 text-xl font-black tabular-nums">{s.value}</p>
                </div>
              ))}
            </div>

            {totals.unratedEntries > 0 && totals.entries > 0 && (
              <p className="text-xs text-muted-foreground">
                {totals.unratedEntries} of {totals.entries} entries have no rate recorded, so any cost shown covers only
                the rest. Rates are frozen when an entry is approved and are never backfilled.
              </p>
            )}

            {report.data!.truncated && (
              <p className="text-xs font-medium text-destructive">
                More than {report.data!.rowsScanned.toLocaleString()} entries match — the figures above cover only that
                many. Narrow the date range.
              </p>
            )}

            <div className="max-w-full overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th scope="col" className="px-3 py-2 text-left font-semibold">{GROUP_LABEL[groupBy]}</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Hours</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Billable</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Entries</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">People</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {report.data!.groups.map((g) => (
                    <tr key={g.key} className="border-b border-border last:border-0">
                      <td className="px-3 py-2">
                        <span className="block font-medium">{g.label}</span>
                        {g.firstDate && (
                          <span className="block text-xs text-muted-foreground">
                            {g.firstDate === g.lastDate ? g.firstDate : `${g.firstDate} → ${g.lastDate}`}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{hours(g.hours)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{hours(g.billableHours)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{g.entries}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{g.people}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {g.cost === null ? <span className="text-muted-foreground">—</span> : g.cost.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                  {report.data!.groups.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                        No entries match these filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
