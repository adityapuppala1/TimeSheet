import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Mail,
  ShieldCheck,
  ShieldX,
  TrendingUp,
  Users2
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { toast } from "../components/ui/toaster";
import { fileUrl, teamApi, timesheetApi } from "../services/api";

function initialsFor(name?: string) {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function relativeTime(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "moments ago";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  return `${Math.floor(diff / day)}d ago`;
}

export function Team() {
  const queryClient = useQueryClient();
  const reports = useQuery({ queryKey: ["team", "reports"], queryFn: teamApi.reports });
  const summary = useQuery({ queryKey: ["team", "sla-summary"], queryFn: teamApi.slaSummary });
  const escalations = useQuery({ queryKey: ["team", "escalations"], queryFn: teamApi.escalations });

  const approve = useMutation({
    mutationFn: (id: string) => timesheetApi.approve(id),
    onSuccess: () => {
      toast.success("Approved");
      queryClient.invalidateQueries({ queryKey: ["team"] });
      queryClient.invalidateQueries({ queryKey: ["timesheets"] });
    },
    onError: (err: any) => toast.error("Approval failed", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
            <Users2 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight">My team</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Direct reports, approval queue, and SLA health — all in one view.
            </p>
          </div>
        </div>
      </div>

      {/* Top stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard
          label="Awaiting approval"
          value={summary.data?.submitted ?? 0}
          icon={<Clock className="h-4 w-4" />}
          tone={(summary.data?.submitted ?? 0) > 0 ? "warning" : "default"}
          loading={summary.isLoading}
        />
        <StatCard
          label="SLA breached"
          value={summary.data?.breached ?? 0}
          icon={<AlertTriangle className="h-4 w-4" />}
          tone={(summary.data?.breached ?? 0) > 0 ? "destructive" : "default"}
          loading={summary.isLoading}
        />
        <StatCard
          label="Approved this week"
          value={summary.data?.approvedThisWeek ?? 0}
          icon={<CheckCircle2 className="h-4 w-4" />}
          tone="success"
          loading={summary.isLoading}
        />
        <StatCard
          label="Open escalations"
          value={summary.data?.openEscalations ?? 0}
          icon={<ShieldX className="h-4 w-4" />}
          tone={(summary.data?.openEscalations ?? 0) > 0 ? "destructive" : "default"}
          loading={summary.isLoading}
        />
      </div>

      {/* Escalations to me */}
      {(escalations.data?.length ?? 0) > 0 && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldX className="h-4 w-4 text-destructive" />
              Escalations awaiting your decision
            </CardTitle>
            <CardDescription>These approvals missed their SLA and were escalated up to you.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Original reviewer</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Work date</TableHead>
                  <TableHead>Hours</TableHead>
                  <TableHead>Escalated</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(escalations.data ?? []).map((row: any) => {
                  const avatarSrc = fileUrl(row.timesheet?.user?.avatarUrl);
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Avatar className="h-7 w-7">
                            {avatarSrc ? <AvatarImage src={avatarSrc} alt={row.timesheet?.user?.name ?? ""} /> : null}
                            <AvatarFallback>{initialsFor(row.timesheet?.user?.name)}</AvatarFallback>
                          </Avatar>
                          <span className="font-medium">{row.timesheet?.user?.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{row.escalatedFromUser?.name}</TableCell>
                      <TableCell>{row.timesheet?.project?.name}</TableCell>
                      <TableCell className="text-muted-foreground">{String(row.timesheet?.workDate ?? "").slice(0, 10)}</TableCell>
                      <TableCell className="font-semibold">{Number(row.timesheet?.totalHours ?? 0).toFixed(2)}</TableCell>
                      <TableCell className="text-xs text-destructive">{relativeTime(row.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="success" onClick={() => approve.mutate(row.timesheet.id)}>
                          <CheckCircle2 className="h-4 w-4" />Approve
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Direct reports */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-4 w-4 text-primary" /> Direct reports
          </CardTitle>
          <CardDescription>Roll-up of every report's submissions, approvals, and SLA history.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">Pending</TableHead>
                <TableHead className="text-right">Approved</TableHead>
                <TableHead className="text-right">Rejected</TableHead>
                <TableHead className="text-right">SLA breaches</TableHead>
                <TableHead className="text-right">Approved hours</TableHead>
                <TableHead>Contact</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.isLoading &&
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={`skel-${i}`}>
                    {Array.from({ length: 8 }).map((__, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))}
              {!reports.isLoading &&
                (reports.data ?? []).map((person) => {
                  const avatarSrc = fileUrl(person.avatarUrl);
                  return (
                    <TableRow key={person.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar>
                            {avatarSrc ? <AvatarImage src={avatarSrc} alt={person.name} /> : null}
                            <AvatarFallback>{initialsFor(person.name)}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="truncate font-medium">{person.name}</p>
                            {person.bio && (
                              <p className="line-clamp-1 text-xs text-muted-foreground">{person.bio}</p>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell><Badge variant="info">{person.role.replace("_", " ")}</Badge></TableCell>
                      <TableCell className="text-right">
                        {person.stats.pending > 0 ? (
                          <Badge variant="warning">{person.stats.pending}</Badge>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-semibold text-success">{person.stats.approved}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{person.stats.rejected}</TableCell>
                      <TableCell className="text-right">
                        {person.stats.slaBreached > 0 ? (
                          <Badge variant="destructive">{person.stats.slaBreached}</Badge>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-semibold">{person.stats.approvedHours.toFixed(2)}</TableCell>
                      <TableCell>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <a
                              href={`mailto:${person.email}`}
                              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                            >
                              <Mail className="h-3.5 w-3.5" />Email
                            </a>
                          </TooltipTrigger>
                          <TooltipContent>{person.email}</TooltipContent>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  );
                })}
              {!reports.isLoading && (reports.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-12 text-center">
                    <div className="grid place-items-center gap-2 text-muted-foreground">
                      <div className="grid h-12 w-12 place-items-center rounded-full bg-muted">
                        <Users2 className="h-6 w-6" />
                      </div>
                      <p className="font-semibold text-foreground">No direct reports yet</p>
                      <p className="text-xs">
                        Assign a manager to teammates from <span className="font-semibold text-foreground">Users → Edit → Manager</span>.
                      </p>
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

function StatCard({
  label,
  value,
  icon,
  tone = "default",
  loading
}: {
  label: string;
  value: number;
  icon?: React.ReactNode;
  tone?: "default" | "success" | "warning" | "destructive";
  loading?: boolean;
}) {
  const toneClass =
    tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : tone === "destructive" ? "text-destructive" : "";
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{label}</p>
          <span className={`opacity-70 ${toneClass}`}>{icon ?? <AlarmClock className="h-4 w-4" />}</span>
        </div>
        {loading ? (
          <Skeleton className="mt-2 h-9 w-20" />
        ) : (
          <p className={`mt-2 text-3xl font-black tracking-tight ${toneClass}`}>{value}</p>
        )}
      </CardContent>
    </Card>
  );
}

export const _unused = ShieldCheck;
