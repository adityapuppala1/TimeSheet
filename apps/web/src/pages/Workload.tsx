/**
 * The Workload board — person × week, coloured by how booked each person is, with planned and
 * actual hours side by side.
 *
 * WHY THE CELL SHOWS BOTH BOOKED AND LOGGED: this is the one thing a pure PM tool cannot do.
 * Wrike and the rest only ever hold estimates, so they can compare a plan against another plan.
 * This app has approved timesheets, so "Ana is booked at 110%" (a forecast) becomes "Ana is
 * booked at 110% and logged 46 hours last week" (evidence). The second sentence is the reason
 * anyone believes the first.
 *
 * WHY THE COLOUR RAMP BREAKS HUE AT THE TOP STEP: capacity-0..3 are one hue at four lightnesses,
 * because a ramp that shifts hue encodes a second variable that does not exist. capacity-4 is
 * deliberately the destructive hue — "over capacity" is a categorically different state from
 * "busy", not simply more of it, and that is the one place a hue change carries real meaning.
 * See index.css.
 *
 * WHY 100% IS NOT RED: a person booked to exactly their capacity is fully booked, which is the
 * intended state. Flagging it would light up the whole board on a well-planned sprint and train
 * everyone to ignore the colour. The threshold is 102% — see workload.service.ts.
 *
 * WHO renders this: `App.tsx` at `/app/workload`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, Loader2, Lock, Plus, Trash2, Users2, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { permissions } from "@timesheet/shared";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { StatCard } from "../components/ui/stat-card";
import { Switch } from "../components/ui/switch";
import { toast } from "../components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { useAuthStore } from "../store/auth";
import {
  fileUrl,
  planningApi,
  projectApi,
  resourceApi,
  userApi,
  type ResourceBookingRow,
  type WorkloadCellRow
} from "../services/api";
import { DateRangePicker } from "../components/ui/date-range-picker";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

const initials = (name?: string) =>
  (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");

/**
 * Which step of the capacity ramp a cell sits on.
 *
 * The bands are deliberately uneven. 1-59% is "has room" and does not need four shades to say so;
 * the interesting range is 60-100%, where a planner decides whether one more task fits. Even
 * quintiles would spend most of the palette on distinctions nobody acts on.
 */
function ramp(cell: WorkloadCellRow): 0 | 1 | 2 | 3 | 4 {
  if (cell.isOverAllocated) return 4;
  const pct = cell.allocationPct;
  if (pct === null || pct === 0) return 0;
  if (pct < 60) return 1;
  if (pct < 90) return 2;
  return 3;
}

const RAMP_CLASS = ["bg-capacity-0", "bg-capacity-1", "bg-capacity-2", "bg-capacity-3", "bg-capacity-4"] as const;
/** Steps 3 and 4 are dark enough that dark-on-them fails contrast; the rest keep body colour. */
const RAMP_TEXT = ["text-muted-foreground", "text-foreground", "text-foreground", "text-white", "text-white"] as const;

const todayIso = () => new Date().toISOString().slice(0, 10);
const isoPlusDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export function WorkloadPage() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const canManage = Boolean(user?.permissions.includes(permissions.RESOURCES_MANAGE));

  const [projectId, setProjectId] = useState("__all__");
  const [weeks, setWeeks] = useState(8);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [editing, setEditing] = useState<ResourceBookingRow | null>(null);

  const from = todayIso();
  const to = isoPlusDays(weeks * 7);

  const config = useQuery({ queryKey: ["planning", "settings"], queryFn: planningApi.settings });
  const enabled = Boolean(config.data?.effective.resourceManagement) && canManage;

  const board = useQuery({
    queryKey: ["resources", "workload", projectId, weeks],
    queryFn: () => resourceApi.workload({ from, to, projectId: projectId === "__all__" ? undefined : projectId }),
    enabled
  });
  const conflicts = useQuery({
    queryKey: ["resources", "conflicts", weeks],
    queryFn: () => resourceApi.conflicts({ from, to }),
    enabled
  });
  const bookings = useQuery({
    queryKey: ["resources", "bookings", projectId, weeks],
    queryFn: () => resourceApi.listBookings({ from, to, projectId: projectId === "__all__" ? undefined : projectId }),
    enabled
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: projectApi.list, enabled });
  const users = useQuery({ queryKey: ["users"], queryFn: () => userApi.list(), enabled });

  const removeBooking = useMutation({
    mutationFn: (id: string) => resourceApi.deleteBooking(id),
    onSuccess: () => {
      toast.success("Booking removed");
      queryClient.invalidateQueries({ queryKey: ["resources"] });
    },
    onError: (err: any) => toast.error("Could not remove", { description: serverMessage(err, "Try again.") })
  });

  const conflictsByUser = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of conflicts.data ?? []) map.set(c.userId, (map.get(c.userId) ?? 0) + 1);
    return map;
  }, [conflicts.data]);

  if (config.isLoading) return <Skeleton className="h-96 w-full" />;

  if (!canManage) {
    return (
      <div className="mx-auto grid w-full max-w-3xl gap-4 p-4 sm:p-6">
        <Card>
          <CardContent className="grid gap-3 p-8 text-center">
            <Lock className="mx-auto h-8 w-8 text-muted-foreground" />
            <h1 className="text-lg font-semibold">You don&apos;t have access to the workload board</h1>
            <p className="text-sm text-muted-foreground">
              It shows every person&apos;s capacity and hours, so it needs the resource permission.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!config.data?.effective.resourceManagement) {
    const blockedByPlan = config.data?.settings.enableResourceManagement && !config.data?.entitlements.resourceMgmtEnabled;
    return (
      <div className="mx-auto grid w-full max-w-3xl gap-4 p-4 sm:p-6">
        <Card>
          <CardContent className="grid gap-3 p-8 text-center">
            {blockedByPlan ? <Lock className="mx-auto h-8 w-8 text-muted-foreground" /> : <Users2 className="mx-auto h-8 w-8 text-muted-foreground" />}
            <h1 className="text-lg font-semibold">Resource management isn&apos;t switched on</h1>
            <p className="text-sm text-muted-foreground">
              {blockedByPlan
                ? "Capacity, bookings and the workload board are an Enterprise feature."
                : "A super admin can turn it on in Workspace Settings → Planning."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const data = board.data;

  return (
    <div className="grid min-w-0 gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Users2 className="h-5 w-5 text-primary" />
            Workload
          </h1>
          <p className="text-sm text-muted-foreground">
            Planned bookings against real capacity — and the hours actually logged, so the forecast can be checked
            against what happened.
          </p>
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Everyone</SelectItem>
              {(projects.data ?? []).map((p: any) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.code} — {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(weeks)} onValueChange={(v) => setWeeks(Number(v))}>
            <SelectTrigger className="w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="4">4 weeks</SelectItem>
              <SelectItem value="8">8 weeks</SelectItem>
              <SelectItem value="12">12 weeks</SelectItem>
              <SelectItem value="26">26 weeks</SelectItem>
            </SelectContent>
          </Select>
          <Button
            className="shrink-0"
            onClick={() => {
              setEditing(null);
              setBookingOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            Book time
          </Button>
        </div>
      </div>

      {data && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="People" value={String(data.summary.people)} icon={<Users2 className="h-4 w-4" />} />
          <StatCard
            label="Over capacity"
            value={String(data.summary.overAllocated)}
            tone={data.summary.overAllocated > 0 ? "destructive" : "default"}
            icon={<AlertTriangle className="h-4 w-4" />}
          />
          <StatCard
            label="Booked / capacity"
            value={
              <span className="flex flex-wrap items-baseline gap-1.5">
                {data.summary.totalBookedHours.toFixed(0)}h
                <span className="text-xs font-normal text-muted-foreground">of {data.summary.totalCapacityHours.toFixed(0)}h</span>
              </span>
            }
            icon={<CalendarClock className="h-4 w-4" />}
          />
          <StatCard
            label="Actually logged"
            value={`${data.summary.totalLoggedHours.toFixed(0)}h`}
            icon={<Wallet className="h-4 w-4" />}
          />
        </div>
      )}

      {(conflicts.data ?? []).length > 0 && (
        <Card className="border-warning/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-warning" />
              {conflicts.data!.length} double-booking{conflicts.data!.length === 1 ? "" : "s"}
            </CardTitle>
            <CardDescription>
              Overlapping bookings that together exceed someone&apos;s daily capacity. Shown, not blocked — splitting a
              person across two projects for a fortnight is sometimes exactly the plan.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-1.5">
            {conflicts.data!.slice(0, 6).map((c, i) => (
              <div key={`${c.userId}-${i}`} className="flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1.5 text-xs">
                <span className="font-medium">{c.user.name}</span>
                <span className="text-muted-foreground">
                  {c.overlapStart} → {c.overlapEnd}
                </span>
                <Badge variant="warning">{c.combinedHoursPerDay}h/day</Badge>
                <span className="text-muted-foreground">
                  {c.bookings.map((b) => b.project?.code ?? "unassigned").join(" + ")}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {board.isLoading ? (
            <Skeleton className="m-3 h-64" />
          ) : !data || data.rows.length === 0 ? (
            <div className="p-10 text-center">
              <Users2 className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium">Nobody to show</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {projectId === "__all__"
                  ? "Active people appear here automatically."
                  : "No one is assigned to this project yet."}
              </p>
            </div>
          ) : (
            // The grid owns its own horizontal scroll: 26 weekly columns cannot go narrower than
            // legibility allows, and the page must never scroll sideways (see index.css).
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Person
                    </th>
                    {data.buckets.map((b) => (
                      <th key={b.start} className="px-1 py-2 text-center text-[11px] font-medium text-muted-foreground">
                        {b.label}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.person.id} className="border-b border-border/50">
                      <td className="sticky left-0 z-10 bg-card px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <Avatar className="h-6 w-6">
                            {fileUrl(row.person.avatarUrl) ? (
                              <AvatarImage src={fileUrl(row.person.avatarUrl)!} alt={row.person.name} />
                            ) : null}
                            <AvatarFallback className="text-[10px]">{initials(row.person.name)}</AvatarFallback>
                          </Avatar>
                          <div className="grid min-w-0">
                            <span className="truncate text-xs font-medium">{row.person.name}</span>
                            <span className="truncate text-[10px] text-muted-foreground">
                              {row.person.weeklyCapacityHours ?? config.data?.settings.defaultWeeklyCapacityHours ?? 40}h/wk
                              {row.person.plannedUtilizationPct ? ` · ${row.person.plannedUtilizationPct}%` : ""}
                            </span>
                          </div>
                          {conflictsByUser.has(row.person.id) && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
                              </TooltipTrigger>
                              <TooltipContent>
                                <span className="text-xs">{conflictsByUser.get(row.person.id)} double-booking(s)</span>
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </td>
                      {row.cells.map((cell) => {
                        const step = ramp(cell);
                        return (
                          <td key={cell.bucketStart} className="p-0.5">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div
                                  className={cn(
                                    "grid h-9 place-items-center rounded text-[11px] tabular-nums",
                                    RAMP_CLASS[step],
                                    RAMP_TEXT[step]
                                  )}
                                >
                                  {cell.timeOffHours > 0 && cell.capacityHours === 0
                                    ? "off"
                                    : cell.allocationPct === null
                                      ? "—"
                                      : `${cell.allocationPct}%`}
                                </div>
                              </TooltipTrigger>
                              <TooltipContent>
                                <div className="grid gap-0.5 text-xs">
                                  <p className="font-medium">Week of {cell.bucketStart}</p>
                                  <p>
                                    Booked <span className="font-medium">{cell.bookedHours}h</span> of{" "}
                                    <span className="font-medium">{cell.capacityHours}h</span> available
                                  </p>
                                  {/* The comparison a pure PM tool cannot make. */}
                                  <p className="text-muted-foreground">Actually logged {cell.loggedHours}h</p>
                                  {cell.timeOffHours > 0 && <p className="text-muted-foreground">{cell.timeOffHours}h time off</p>}
                                  {cell.isOverAllocated && <p className="text-destructive">Over capacity</p>}
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          </td>
                        );
                      })}
                      <td className="px-3 py-1.5 text-right">
                        <div className="grid">
                          <span className={cn("text-xs font-medium tabular-nums", row.totals.overAllocatedBuckets > 0 && "text-destructive")}>
                            {row.totals.allocationPct === null ? "—" : `${row.totals.allocationPct}%`}
                          </span>
                          <span className="text-[10px] text-muted-foreground tabular-nums">
                            {row.totals.bookedHours}h / {row.totals.loggedHours}h
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-5 rounded-sm bg-capacity-0" /> free
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-5 rounded-sm bg-capacity-2" /> booked
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-5 rounded-sm bg-capacity-3" /> at capacity
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-5 rounded-sm bg-capacity-4" /> over capacity
        </span>
        <span className="ml-2">Totals read as booked&nbsp;/&nbsp;logged.</span>
      </div>

      {/* Bookings list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Bookings in this window</CardTitle>
          <CardDescription>
            Hours are per <span className="font-medium">working</span> day, so a 5-day booking at 4h/day is 20 hours, not 28.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-1.5">
          {bookings.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (bookings.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No bookings yet.</p>
          ) : (
            bookings.data!.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-xs">
                <span className="font-medium">{b.user.name}</span>
                {b.isTimeOff ? (
                  <Badge variant="secondary">Time off</Badge>
                ) : (
                  <Badge variant="outline">{b.project?.code ?? "unassigned"}</Badge>
                )}
                <span className="text-muted-foreground">
                  {b.startDate} → {b.endDate}
                </span>
                <Badge variant="info">{b.hoursPerDay}h/day</Badge>
                {b.note && <span className="truncate text-muted-foreground">{b.note}</span>}
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7"
                    onClick={() => {
                      setEditing(b);
                      setBookingOpen(true);
                    }}
                  >
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2" disabled={removeBooking.isPending} onClick={() => removeBooking.mutate(b.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <BookingDialog
        open={bookingOpen}
        onOpenChange={setBookingOpen}
        editing={editing}
        people={(users.data ?? []) as any[]}
        projects={(projects.data ?? []) as any[]}
      />
    </div>
  );
}

function BookingDialog({
  open,
  onOpenChange,
  editing,
  people,
  projects
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: ResourceBookingRow | null;
  people: any[];
  projects: any[];
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    userId: "",
    projectId: "",
    startDate: todayIso(),
    endDate: isoPlusDays(4),
    hoursPerDay: "4",
    note: "",
    isTimeOff: false
  });

  // Re-seed whenever the dialog opens, so "Edit" shows the booking and "Book time" shows a blank
  // form rather than whichever row was edited last.
  useMemo(() => {
    if (!open) return;
    setForm(
      editing
        ? {
            userId: editing.userId,
            projectId: editing.projectId ?? "",
            startDate: editing.startDate,
            endDate: editing.endDate,
            hoursPerDay: String(editing.hoursPerDay),
            note: editing.note ?? "",
            isTimeOff: editing.isTimeOff
          }
        : { userId: "", projectId: "", startDate: todayIso(), endDate: isoPlusDays(4), hoursPerDay: "4", note: "", isTimeOff: false }
    );
  }, [open, editing]);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        userId: form.userId,
        projectId: form.isTimeOff || !form.projectId ? null : form.projectId,
        startDate: form.startDate,
        endDate: form.endDate,
        hoursPerDay: Number(form.hoursPerDay),
        note: form.note || null,
        isTimeOff: form.isTimeOff
      };
      return editing ? resourceApi.updateBooking(editing.id, payload) : resourceApi.createBooking(payload);
    },
    onSuccess: () => {
      toast.success(editing ? "Booking updated" : "Time booked");
      queryClient.invalidateQueries({ queryKey: ["resources"] });
      onOpenChange(false);
    },
    onError: (err: any) => toast.error("Could not save", { description: serverMessage(err, "Try again.") })
  });

  const invalid = !form.userId || !form.startDate || !form.endDate || form.endDate < form.startDate || Number(form.hoursPerDay) <= 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit booking" : "Book time"}</DialogTitle>
          <DialogDescription>
            Reserves someone&apos;s time. Overlaps are allowed and reported rather than refused — splitting a person
            across two projects is sometimes exactly the plan.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Person</Label>
            <Select value={form.userId} onValueChange={(v) => setForm({ ...form, userId: v })}>
              <SelectTrigger>
                <SelectValue placeholder="Pick someone" />
              </SelectTrigger>
              <SelectContent>
                {people.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Switch checked={form.isTimeOff} onCheckedChange={(v) => setForm({ ...form, isTimeOff: v })} />
            Time off (leave, holiday, training)
          </label>

          {!form.isTimeOff && (
            <div className="grid gap-1.5">
              <Label>Project</Label>
              <Select value={form.projectId} onValueChange={(v) => setForm({ ...form, projectId: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="Optional" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.code} — {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">

              <Label htmlFor="workload-range">Date range</Label>

              <DateRangePicker

                id="workload-range"

                value={{ from: form.startDate, to: form.endDate }}

                onChange={(range) => setForm({ ...form, startDate: range.from, endDate: range.to })}

                allowAllTime={false}

              />

            </div>
            <div className="grid gap-1.5">
              <Label>Hours / working day</Label>
              <Input
                type="number"
                min={0.25}
                max={24}
                step="0.25"
                value={form.hoursPerDay}
                onChange={(e) => setForm({ ...form, hoursPerDay: e.target.value })}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Note</Label>
            <Input value={form.note} placeholder="Optional" onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>

          {form.endDate < form.startDate && (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertTriangle className="h-3 w-3" />
              The booking ends before it starts.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={invalid || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {editing ? "Save" : "Book"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
