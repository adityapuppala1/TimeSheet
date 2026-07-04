import { useQuery } from "@tanstack/react-query";
import { CalendarRange, Clock, FileText, Filter, Layers, Paperclip, RotateCcw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { projectApi, timesheetApi } from "../services/api";
import { safeHtml } from "../lib/safe-html";

type StatusFilter = "ALL" | "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";

const statusVariant: Record<string, "success" | "warning" | "destructive" | "muted"> = {
  APPROVED: "success",
  SUBMITTED: "warning",
  DRAFT: "muted",
  REJECTED: "destructive"
};

export function History() {
  const timesheets = useQuery({ queryKey: ["timesheets"], queryFn: timesheetApi.list });
  const projects = useQuery({ queryKey: ["projects"], queryFn: projectApi.list });
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [projectId, setProjectId] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");

  const rows: any[] = Array.isArray(timesheets.data) ? timesheets.data : [];

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (status !== "ALL" && row.status !== status) return false;
      if (projectId !== "all" && row.projectId !== projectId) return false;
      if (from && String(row.workDate).slice(0, 10) < from) return false;
      if (to && String(row.workDate).slice(0, 10) > to) return false;
      if (search) {
        const haystack = `${row.taskDescription ?? ""} ${row.notes ?? ""} ${row.activityType ?? ""}`.toLowerCase();
        if (!haystack.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [rows, status, projectId, from, to, search]);

  const summary = useMemo(() => {
    return filtered.reduce(
      (acc, row) => {
        const hours = Number(row.totalHours ?? 0);
        acc.hours += hours;
        acc.count += 1;
        if (row.status === "APPROVED") acc.approved += hours;
        if (row.status === "SUBMITTED") acc.pending += hours;
        if (row.status === "REJECTED") acc.rejected += hours;
        return acc;
      },
      { hours: 0, count: 0, approved: 0, pending: 0, rejected: 0 }
    );
  }, [filtered]);

  function resetFilters() {
    setStatus("ALL");
    setProjectId("all");
    setFrom("");
    setTo("");
    setSearch("");
  }

  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-2xl font-black tracking-tight">Timesheet history</h1>
        <p className="mt-1 text-sm text-muted-foreground">Filter and review every entry you've logged. Hours roll up live as you adjust filters.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
        <Stat label="Entries" value={summary.count} />
        <Stat label="Logged hours" value={summary.hours.toFixed(2)} />
        <Stat label="Approved hours" value={summary.approved.toFixed(2)} tone="success" />
        <Stat label="Pending hours" value={summary.pending.toFixed(2)} tone="warning" />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Filter className="h-4 w-4" /> Filters
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            <RotateCcw className="h-3.5 w-3.5" />Reset
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-5">
            <div className="grid gap-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All statuses</SelectItem>
                  <SelectItem value="DRAFT">Draft</SelectItem>
                  <SelectItem value="SUBMITTED">Submitted</SelectItem>
                  <SelectItem value="APPROVED">Approved</SelectItem>
                  <SelectItem value="REJECTED">Rejected</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Project</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All projects</SelectItem>
                  {(projects.data ?? []).map((project: any) => (
                    <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>From</Label>
              <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>To</Label>
              <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Search</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input className="pl-9" placeholder="task, activity, notes" value={search} onChange={(event) => setSearch(event.target.value)} />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Project / Module</TableHead>
                <TableHead>Activity</TableHead>
                <TableHead>Time</TableHead>
                <TableHead className="text-right">Hours</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Task</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row: any) => (
                <TableRow key={row.id} className="align-top">
                  <TableCell className="whitespace-nowrap font-medium">{String(row.workDate).slice(0, 10)}</TableCell>
                  <TableCell>
                    <p className="font-medium">{row.project?.name}</p>
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Layers className="h-3 w-3" />
                      {row.module?.name}
                      {row.submodule ? ` / ${row.submodule.name}` : ""}
                    </p>
                    {row.ticket && (
                      <Badge variant="outline" className="mt-1 font-mono text-[10px]">{row.ticket.key}</Badge>
                    )}
                  </TableCell>
                  <TableCell>{row.activityType}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {row.startTime}–{row.endTime}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-semibold">{Number(row.totalHours).toFixed(2)}</TableCell>
                  <TableCell><Badge variant={statusVariant[row.status] ?? "muted"}>{row.status}</Badge></TableCell>
                  <TableCell className="max-w-md">
                    <div className="flex items-start gap-1 text-foreground/80">
                      <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="prose-sm line-clamp-2" dangerouslySetInnerHTML={safeHtml(row.taskDescription)} />
                    </div>
                    {row.attachments?.length ? (
                      <p className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Paperclip className="h-3 w-3" />
                        {row.attachments.length} attachment(s)
                      </p>
                    ) : null}
                    {row.status === "REJECTED" && row.rejectionReason ? (
                      <p className="mt-1 text-xs text-destructive">Reason: {row.rejectionReason}</p>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
              {!filtered.length && (
                <TableRow>
                  <TableCell colSpan={7} className="py-12 text-center">
                    <div className="grid place-items-center gap-2 text-muted-foreground">
                      <CalendarRange className="h-6 w-6" />
                      <p>No entries match the current filters.</p>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, tone = "default" }: { label: string; value: number | string; tone?: "default" | "success" | "warning" }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={`mt-2 text-3xl font-black tracking-tight ${tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : ""}`}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
