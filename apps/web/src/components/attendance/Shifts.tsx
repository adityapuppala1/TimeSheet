/**
 * 7.0.0 shifts/rosters.
 *
 * - ShiftsSettingsSection (Workspace settings → Attendance → Shifts): define shifts and assign them to
 *   a person or a manager's team from a date. With none assigned, everyone keeps the workspace day.
 * - MyShiftLine: the "your shift" line on My attendance, from /attendance/me/today. Renders nothing
 *   when the person has no shift.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { runInBackground } from "../../lib/run-in-background";
import { api, userApi } from "../../services/api";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { SearchableSelect } from "../ui/searchable-select";
import { Skeleton } from "../ui/skeleton";
import { toast } from "../ui/toaster";
import { CardError, SectionCard, todayKey } from "./attendance-ui";

export interface ShiftRow {
  id: string;
  name: string;
  startMinute: number;
  endMinute: number;
  breakMinutes: number;
  workingDays: number[];
}
export interface ShiftAssignmentRow {
  id: string;
  shiftId: string;
  user: { id: string; name: string } | null;
  team: { managerId: string; managerName: string } | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

const KEY = ["attendance-admin", "shifts"] as const;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const serverMessage = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

const shiftsApi = {
  list: async () => (await api.get<{ shifts: ShiftRow[]; assignments: ShiftAssignmentRow[] }>("/attendance/admin/shifts")).data,
  create: async (body: Omit<ShiftRow, "id">) => (await api.post<ShiftRow>("/attendance/admin/shifts", body)).data,
  remove: async (id: string) => api.delete(`/attendance/admin/shifts/${id}`),
  assign: async (body: { shiftId: string; userId?: string; managerId?: string; effectiveFrom: string; effectiveTo?: string | null }) =>
    (await api.post("/attendance/admin/shift-assignments", body)).data,
  unassign: async (id: string) => api.delete(`/attendance/admin/shift-assignments/${id}`)
};

/** "22:00" for 1320 (pure). */
export function minuteText(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "22:00–06:00 (next day) · 30 min break · Mon–Fri" style summary (pure). */
export function shiftSummary(s: Pick<ShiftRow, "startMinute" | "endMinute" | "breakMinutes" | "workingDays">): string {
  const next = s.endMinute <= s.startMinute ? " (next day)" : "";
  const brk = s.breakMinutes ? ` · ${s.breakMinutes} min break` : "";
  const days = [...s.workingDays].sort((a, b) => a - b).map((d) => DAYS[d]).join(", ");
  return `${minuteText(s.startMinute)}–${minuteText(s.endMinute)}${next}${brk} · ${days}`;
}

function toMinute(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function ShiftsSettingsSection({ readOnly }: Readonly<{ readOnly: boolean }>) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: KEY, queryFn: shiftsApi.list });
  const people = useQuery({ queryKey: ["leave-admin", "people"], queryFn: () => userApi.list(), staleTime: 5 * 60_000 });
  const options = useMemo(() => (people.data ?? []).map((u) => ({ id: u.id, name: u.name })), [people.data]);
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });

  const [name, setName] = useState("");
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("18:00");
  const [breakMin, setBreakMin] = useState("60");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const startM = toMinute(start);
  const endM = toMinute(end);
  const brk = Number(breakMin);
  const valid = Boolean(name.trim()) && startM !== null && endM !== null && startM !== endM && Number.isInteger(brk) && brk >= 0 && brk <= 720 && days.length > 0;

  const create = useMutation({
    mutationFn: () => shiftsApi.create({ name: name.trim(), startMinute: startM!, endMinute: endM!, breakMinutes: brk, workingDays: days }),
    onSuccess: async () => {
      toast.success("Shift added");
      setName("");
      await refresh();
    },
    onError: (err) => toast.error("Could not add the shift", { description: serverMessage(err, "Try again.") })
  });
  const remove = useMutation({
    mutationFn: shiftsApi.remove,
    onSuccess: refresh,
    onError: (err) => toast.error("Could not remove the shift", { description: serverMessage(err, "Try again.") })
  });

  const [shiftId, setShiftId] = useState("");
  const [target, setTarget] = useState<"person" | "team">("person");
  const [who, setWho] = useState("");
  const [from, setFrom] = useState(todayKey());
  const assign = useMutation({
    mutationFn: () => shiftsApi.assign({ shiftId, ...(target === "person" ? { userId: who } : { managerId: who }), effectiveFrom: from }),
    onSuccess: async () => {
      toast.success("Shift assigned");
      setWho("");
      await refresh();
    },
    onError: (err) => toast.error("Could not assign the shift", { description: serverMessage(err, "Try again.") })
  });
  const unassign = useMutation({ mutationFn: shiftsApi.unassign, onSuccess: refresh });

  if (query.isLoading) return <Skeleton className="h-40 w-full" />;
  if (query.isError || !query.data) return <CardError message="Shifts could not be loaded." onRetry={() => runInBackground(query.refetch())} />;
  const { shifts, assignments } = query.data;
  const nameOf = new Map(shifts.map((s) => [s.id, s.name]));

  return (
    <div className="grid min-w-0 gap-4">
      <SectionCard title="Shifts" description="People without a shift keep the workspace working day. A shift that ends before it starts runs past midnight and counts on the day it starts.">
        {shifts.length === 0 ? (
          <EmptyState icon={Clock} title="No shifts yet" description="Everyone follows the workspace working days and start time." />
        ) : (
          <ul className="grid gap-2">
            {shifts.map((s) => (
              <li key={s.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{s.name}</p>
                  <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{shiftSummary(s)}</p>
                </div>
                {!readOnly && (
                  <Button variant="ghost" size="sm" className="min-h-[44px]" aria-label={`Remove ${s.name}`} onClick={() => remove.mutate(s.id)}>
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!readOnly && (
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) create.mutate();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="shift-name">Name</Label>
              <Input id="shift-name" value={name} maxLength={80} placeholder="Night shift" onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="shift-start">Starts</Label>
                <Input id="shift-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="shift-end">Ends</Label>
                <Input id="shift-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="shift-break">Break (min)</Label>
                <Input id="shift-break" type="number" min={0} max={720} value={breakMin} onChange={(e) => setBreakMin(e.target.value)} />
              </div>
            </div>
            <fieldset className="grid gap-1.5 sm:col-span-2">
              <legend className="text-sm font-medium">Working days</legend>
              <div className="flex flex-wrap gap-1.5">
                {DAYS.map((label, d) => {
                  const on = days.includes(d);
                  return (
                    <Button
                      key={label}
                      type="button"
                      size="sm"
                      variant={on ? "default" : "outline"}
                      aria-pressed={on}
                      className="min-h-[44px] min-w-[44px]"
                      onClick={() => setDays(on ? days.filter((x) => x !== d) : [...days, d])}
                    >
                      {label}
                    </Button>
                  );
                })}
              </div>
            </fieldset>
            <Button type="submit" className="min-h-[44px] justify-self-start" disabled={!valid || create.isPending}>
              {create.isPending ? "Adding…" : "Add shift"}
            </Button>
          </form>
        )}
      </SectionCard>

      <SectionCard title="Who works which shift" description="A person's own assignment beats their team's. The newest start date wins.">
        {assignments.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nobody is on a shift.</p>
        ) : (
          <ul className="grid gap-2">
            {assignments.map((a) => (
              <li key={a.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {a.user ? a.user.name : `${a.team?.managerName}'s team`} · {nameOf.get(a.shiftId) ?? "Shift"} · from {a.effectiveFrom}
                  {a.effectiveTo ? ` to ${a.effectiveTo}` : ""}
                </span>
                {!readOnly && (
                  <Button variant="ghost" size="sm" className="min-h-[44px]" aria-label="Remove assignment" onClick={() => unassign.mutate(a.id)}>
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!readOnly && shifts.length > 0 && (
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (shiftId && who && from) assign.mutate();
            }}
          >
            <div className="grid gap-1.5">
              <Label>Shift</Label>
              <SearchableSelect options={shifts.map((s) => ({ id: s.id, name: s.name }))} value={shiftId} onChange={setShiftId} placeholder="Pick a shift" />
            </div>
            <div className="grid gap-1.5">
              <Label>{target === "person" ? "Person" : "Manager (their whole team)"}</Label>
              <div className="flex gap-1.5">
                <Button type="button" size="sm" className="min-h-[44px]" variant={target === "person" ? "default" : "outline"} aria-pressed={target === "person"} onClick={() => setTarget("person")}>
                  Person
                </Button>
                <Button type="button" size="sm" className="min-h-[44px]" variant={target === "team" ? "default" : "outline"} aria-pressed={target === "team"} onClick={() => setTarget("team")}>
                  Team
                </Button>
              </div>
              <SearchableSelect options={options} value={who} onChange={setWho} placeholder="Pick a person" searchPlaceholder="Search people…" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="shift-from">From</Label>
              <Input id="shift-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <Button type="submit" className="min-h-[44px] self-end justify-self-start" disabled={!shiftId || !who || assign.isPending}>
              {assign.isPending ? "Assigning…" : "Assign"}
            </Button>
          </form>
        )}
      </SectionCard>
    </div>
  );
}

/** "Your shift: Night shift, 22:00–06:00 (next day)". Nothing when there is no shift. */
export function MyShiftLine({ shift }: Readonly<{ shift?: Pick<ShiftRow, "name" | "startMinute" | "endMinute" | "breakMinutes" | "workingDays"> | null }>) {
  if (!shift) return null;
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="my-shift">
      <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="[overflow-wrap:anywhere]">
        Your shift: {shift.name}, {shiftSummary(shift)}
      </span>
    </p>
  );
}
