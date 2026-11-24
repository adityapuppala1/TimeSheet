/**
 * 7.0.0 birthday and work-anniversary strip (apps/api/src/services/celebrations.service.ts).
 *
 *   CelebrationsStrip         "This week" on the Dashboard and the Team leave calendar. Renders
 *                             nothing while the setting is off or nobody has a day this week.
 *   CelebrationsProfileCard   Profile: my birthday (the year stays private) and the opt-out.
 *
 * Day and month only — never a year or an age. Years of service only when 1 or more.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cake, PartyPopper } from "lucide-react";
import { useEffect, useState } from "react";
import { runInBackground } from "../../lib/run-in-background";
import { api } from "../../services/api";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toaster";

export interface CelebrationItem {
  userId: string;
  name: string;
  avatarUrl: string | null;
  kind: "BIRTHDAY" | "ANNIVERSARY";
  monthDay: string;
  date: string;
  years?: number;
}

interface MyCelebrations {
  enabled: boolean;
  dateOfBirth: string | null;
  joinDate: string | null;
  celebrationsOptOut: boolean;
}

export const celebrationsApi = {
  week: async () => (await api.get<{ enabled: boolean; from: string | null; to: string | null; items: CelebrationItem[] }>("/attendance/celebrations")).data,
  mine: async () => (await api.get<MyCelebrations>("/attendance/celebrations/me")).data,
  saveMine: async (body: { dateOfBirth?: string | null; celebrationsOptOut?: boolean }) => (await api.put<MyCelebrations>("/attendance/celebrations/me", body)).data
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Pure: "11-25" → "25 Nov". Never a year. */
export function dayMonthLabel(monthDay: string): string {
  const [m, d] = monthDay.split("-").map(Number);
  return `${d} ${MONTHS[m - 1] ?? ""}`.trim();
}

/** Pure: the line for one item. */
export function celebrationText(item: CelebrationItem): string {
  if (item.kind === "BIRTHDAY") return `${item.name} · birthday · ${dayMonthLabel(item.monthDay)}`;
  const years = item.years && item.years >= 1 ? ` · ${item.years} ${item.years === 1 ? "year" : "years"}` : "";
  return `${item.name} · work anniversary${years} · ${dayMonthLabel(item.monthDay)}`;
}

export function CelebrationsStrip() {
  const week = useQuery({ queryKey: ["attendance", "celebrations"], queryFn: celebrationsApi.week, staleTime: 10 * 60_000, retry: false });
  if (!week.data?.enabled || week.data.items.length === 0) return null;
  return (
    <section aria-label="Birthdays and work anniversaries this week" className="min-w-0 rounded-lg border bg-card p-3">
      <h2 className="mb-2 text-sm font-medium">This week</h2>
      <ul className="flex min-w-0 flex-wrap gap-2">
        {week.data.items.map((item) => (
          <li key={`${item.userId}-${item.kind}`} className="flex min-w-0 items-center gap-1.5 rounded-full border px-3 py-1 text-sm">
            {item.kind === "BIRTHDAY" ? <Cake className="h-4 w-4 shrink-0" aria-hidden /> : <PartyPopper className="h-4 w-4 shrink-0" aria-hidden />}
            <span className="truncate">{celebrationText(item)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CelebrationsProfileCard() {
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ["attendance", "celebrations", "me"], queryFn: celebrationsApi.mine, retry: false });
  const [dob, setDob] = useState("");
  useEffect(() => {
    if (mine.data) setDob(mine.data.dateOfBirth ?? "");
  }, [mine.data]);
  const save = useMutation({
    mutationFn: celebrationsApi.saveMine,
    onSuccess: (data) => {
      qc.setQueryData(["attendance", "celebrations", "me"], data);
      runInBackground(qc.invalidateQueries({ queryKey: ["attendance", "celebrations"] }));
      toast.success("Saved");
    },
    onError: (err) => toast.error("Could not save", { description: (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Try again." })
  });
  if (!mine.data?.enabled) return null;
  const data = mine.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Birthday and work anniversary</CardTitle>
        <CardDescription>Colleagues who can see your team see the day and month only — never the year or your age.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1.5 sm:max-w-xs">
          <Label htmlFor="celebrations-dob">Birthday</Label>
          <Input id="celebrations-dob" type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
          <p className="text-xs text-muted-foreground">Optional. Only you and super admins can see the year.</p>
        </div>
        <p className="text-sm text-muted-foreground">Joined: {data.joinDate ? new Date(`${data.joinDate}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "not set (an administrator sets this)"}</p>
        <div className="flex items-center gap-3">
          <Switch id="celebrations-optout" checked={!data.celebrationsOptOut} disabled={save.isPending} onCheckedChange={(v) => save.mutate({ celebrationsOptOut: !v })} />
          <Label htmlFor="celebrations-optout">Show me in the “This week” strip ({data.celebrationsOptOut ? "Off" : "On"})</Label>
        </div>
        <div>
          <Button disabled={save.isPending || dob === (data.dateOfBirth ?? "")} onClick={() => save.mutate({ dateOfBirth: dob || null })}>
            Save birthday
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
