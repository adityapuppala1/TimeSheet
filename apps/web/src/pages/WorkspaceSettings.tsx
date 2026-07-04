import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  aiModels,
  emailMatchTypes,
  notificationPreferenceKeys,
  type EmailMatchType,
  type GlobalAISettings,
  type GlobalSettings,
  type GlobalTicketSettings,
  type NotificationPreferences
} from "@timesheet/shared";
import {
  AlarmClock,
  BellRing,
  CalendarClock,
  Check,
  Clock,
  Hourglass,
  Inbox,
  Loader2,
  Mail,
  MailCheck,
  Pencil,
  PlugZap,
  Plus,
  Save,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Timer,
  Trash2,
  X
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { toast } from "../components/ui/toaster";
import { emailIntakeApi, labelApi, projectApi, settingsApi, ticketTypeApi, userApi } from "../services/api";
import { useAuthStore } from "../store/auth";

interface ToggleRow {
  key: keyof NotificationPreferences;
  label: string;
  description: string;
  icon: ReactNode;
}

const emailRows: ToggleRow[] = [
  { key: "emailTimesheetSubmitted", label: "Submission confirmation", description: "Email the submitter when a timesheet enters the approval queue.", icon: <Check className="h-4 w-4 text-info" /> },
  { key: "emailTimesheetApproved", label: "Timesheet approved", description: "Email the employee when their entry is approved.", icon: <Check className="h-4 w-4 text-success" /> },
  { key: "emailTimesheetRejected", label: "Timesheet rejected", description: "Email the employee with the reviewer's reason and a fix link.", icon: <X className="h-4 w-4 text-destructive" /> },
  { key: "emailSlaBreach", label: "Approval SLA breached", description: "Email the manager who missed the window before we escalate.", icon: <Hourglass className="h-4 w-4 text-warning" /> },
  { key: "emailEscalation", label: "Approval escalations", description: "Email the manager-of-manager (or admin) when an SLA is missed.", icon: <ShieldX className="h-4 w-4 text-destructive" /> },
  { key: "emailDailyReminder", label: "Daily reminder (4 PM)", description: "Nudge employees who haven't logged today's time.", icon: <Clock className="h-4 w-4 text-primary" /> },
  { key: "emailDailyEscalation", label: "Next-morning escalation (9 AM)", description: "Email both the employee and their manager when yesterday's log was missed.", icon: <Timer className="h-4 w-4 text-destructive" /> },
  { key: "emailDeadlineReminder", label: "Monthly deadline reminder", description: "Email employees a few days before the monthly cutoff.", icon: <CalendarClock className="h-4 w-4 text-warning" /> },
  { key: "emailWeeklyDigest", label: "Weekly digest", description: "AI-authored Monday-morning recap of your ticket and timesheet activity. Requires the AI weekly digest toggle in the AI tab.", icon: <BellRing className="h-4 w-4 text-info" /> },
  { key: "emailTicketNeedsReview", label: "Email-sourced ticket needs review", description: "Alert project admins/managers when an inbound email is classified with low confidence.", icon: <Sparkles className="h-4 w-4 text-warning" /> }
];

const HOURS_24 = Array.from({ length: 24 }, (_, i) => i);

function formatHour(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h12.toString().padStart(2, "0")}:00 ${suffix}  (${hour.toString().padStart(2, "0")}:00)`;
}

export function WorkspaceSettingsPage() {
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === "SUPER_ADMIN";

  return (
    <div className="grid gap-5">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight">Workspace settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isSuperAdmin
              ? "Tune workspace-wide reminders, notification channels, and BCC behavior. Changes apply to everyone."
              : "Read-only view. Only the super admin can change these settings."}
          </p>
        </div>
      </div>

      <Tabs defaultValue="reminders" className="grid gap-4">
        <TabsList className="w-full justify-start sm:w-auto">
          <TabsTrigger value="reminders">Reminders & schedule</TabsTrigger>
          <TabsTrigger value="emails">Email channels</TabsTrigger>
          <TabsTrigger value="ticketing">Ticketing</TabsTrigger>
          <TabsTrigger value="ai">AI</TabsTrigger>
          <TabsTrigger value="email-intake">Email intake</TabsTrigger>
          <TabsTrigger value="bcc">BCC & forms</TabsTrigger>
        </TabsList>

        <TabsContent value="reminders">
          <ReminderScheduleCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="emails">
          <EmailChannelsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="ticketing">
          <TicketingSettingsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="ai">
          <AISettingsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="email-intake">
          <EmailIntakeSettingsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="bcc">
          <BccAndFormsCard readOnly={!isSuperAdmin} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function useSettings() {
  return useQuery({ queryKey: ["settings", "notifications"], queryFn: settingsApi.getNotifications });
}

function useUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Partial<GlobalSettings>) => settingsApi.updateNotifications(payload),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: ["settings", "notifications"] });
      const previous = queryClient.getQueryData<GlobalSettings>(["settings", "notifications"]);
      if (previous) queryClient.setQueryData(["settings", "notifications"], { ...previous, ...payload });
      return { previous };
    },
    onError: (err: any, _p, context) => {
      if (context?.previous) queryClient.setQueryData(["settings", "notifications"], context.previous);
      toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "notifications"] });
    }
  });
}

function ReminderScheduleCard({ readOnly }: { readOnly: boolean }) {
  const settings = useSettings();
  const update = useUpdate();
  const [draftDaily, setDraftDaily] = useState<number | null>(null);
  const [draftEscalation, setDraftEscalation] = useState<number | null>(null);

  useEffect(() => {
    if (settings.data) {
      setDraftDaily(settings.data.dailyReminderHour);
      setDraftEscalation(settings.data.escalationReminderHour);
    }
  }, [settings.data]);

  const dailyChanged = draftDaily !== null && settings.data && draftDaily !== settings.data.dailyReminderHour;
  const escalationChanged = draftEscalation !== null && settings.data && draftEscalation !== settings.data.escalationReminderHour;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlarmClock className="h-4 w-4 text-primary" />
          Daily reminder schedule
        </CardTitle>
        <CardDescription>
          When TimeSphere should nudge employees about today's timesheet, and when to escalate yesterday's missed logs.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {settings.data?.serverTimezone && (
          <div className="flex items-start gap-3 rounded-lg border border-info/40 bg-info/10 p-3 text-sm">
            <AlarmClock className="mt-0.5 h-4 w-4 shrink-0 text-info" />
            <div className="flex-1">
              <p className="font-semibold">
                Reminder hours fire in <span className="text-info">{settings.data.serverTimezone}</span>{" "}
                <span className="text-xs font-normal text-muted-foreground">({settings.data.serverUtcOffset})</span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Set in the API's <code className="rounded bg-background/60 px-1">TZ</code> env var. Restart the API after changing it.
              </p>
            </div>
          </div>
        )}
        {settings.isLoading && (
          <>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </>
        )}
        {!settings.isLoading && settings.data && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="daily-hour" className="flex items-center justify-between">
                  <span>Daily reminder time</span>
                  <span className="text-xs font-normal text-muted-foreground">Mon–Fri only</span>
                </Label>
                <div className="flex gap-2">
                  <Select
                    value={String(draftDaily ?? settings.data.dailyReminderHour)}
                    onValueChange={(value) => setDraftDaily(parseInt(value, 10))}
                    disabled={readOnly}
                  >
                    <SelectTrigger id="daily-hour"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {HOURS_24.map((h) => (
                        <SelectItem key={h} value={String(h)}>{formatHour(h)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {dailyChanged && (
                    <Button
                      size="sm"
                      disabled={readOnly || update.isPending}
                      onClick={() => draftDaily !== null && update.mutate({ dailyReminderHour: draftDaily })}
                    >
                      <Save className="h-4 w-4" />Save
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Nudges every active employee who hasn't logged time for today.
                </p>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="esc-hour" className="flex items-center justify-between">
                  <span>Next-day escalation time</span>
                  <span className="text-xs font-normal text-muted-foreground">Mon–Fri only</span>
                </Label>
                <div className="flex gap-2">
                  <Select
                    value={String(draftEscalation ?? settings.data.escalationReminderHour)}
                    onValueChange={(value) => setDraftEscalation(parseInt(value, 10))}
                    disabled={readOnly}
                  >
                    <SelectTrigger id="esc-hour"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {HOURS_24.map((h) => (
                        <SelectItem key={h} value={String(h)}>{formatHour(h)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {escalationChanged && (
                    <Button
                      size="sm"
                      disabled={readOnly || update.isPending}
                      onClick={() => draftEscalation !== null && update.mutate({ escalationReminderHour: draftEscalation })}
                    >
                      <Save className="h-4 w-4" />Save
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  If yesterday's log is still missing, both employee and manager get a heads-up at this hour.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-4 rounded-lg border border-border bg-muted/30 p-4">
              <div className="mt-1 grid h-8 w-8 place-items-center rounded-md bg-muted">
                <CalendarClock className="h-4 w-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <Label htmlFor="weekdays-only" className={readOnly ? "" : "cursor-pointer"}>Weekdays only</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Skip Saturdays and Sundays. Recommended for office-based teams; turn off for 24/7 operations.
                </p>
              </div>
              <Switch
                id="weekdays-only"
                checked={settings.data.remindOnWeekdaysOnly}
                disabled={readOnly}
                onCheckedChange={(checked) => update.mutate({ remindOnWeekdaysOnly: checked })}
              />
            </div>

            <Alert variant="info">
              <AlarmClock />
              <AlertTitle>How the escalation chain works</AlertTitle>
              <AlertDescription>
                At <strong>{formatHour(settings.data.dailyReminderHour).split("  ")[0]}</strong> {settings.data.serverTimezone ? `${settings.data.serverTimezone}` : "local"} each weekday, anyone without a log entry today gets a reminder.
                If they still haven't logged by <strong>{formatHour(settings.data.escalationReminderHour).split("  ")[0]}</strong> the next business day, they receive a "this was escalated" follow-up and their manager is notified.
              </AlertDescription>
            </Alert>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function EmailChannelsCard({ readOnly }: { readOnly: boolean }) {
  const settings = useSettings();
  const update = useUpdate();

  const allOff = settings.data ? notificationPreferenceKeys.every((key) => !settings.data?.[key]) : false;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="h-4 w-4 text-primary" />
          Email channels
        </CardTitle>
        <CardDescription>
          Workspace-wide on/off for every notification category. In-app alerts always fire — turning these off only mutes outbound email.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {allOff && !settings.isLoading && (
          <Alert variant="warning">
            <ShieldAlert />
            <AlertTitle>All email channels are off</AlertTitle>
            <AlertDescription>No outbound email will be sent. Users will still see in-app alerts in the bell menu.</AlertDescription>
          </Alert>
        )}
        <div className="divide-y divide-border rounded-lg border border-border">
          {settings.isLoading &&
            Array.from({ length: 8 }).map((_, i) => (
              <div key={`s-${i}`} className="flex items-center gap-4 p-4">
                <Skeleton className="h-8 w-8 rounded-md" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
                <Skeleton className="h-6 w-11 rounded-full" />
              </div>
            ))}
          {!settings.isLoading &&
            emailRows.map((row) => {
              const checked = Boolean(settings.data?.[row.key]);
              const inputId = `gns-${row.key}`;
              const isUpdatingThis =
                update.isPending && update.variables && Object.prototype.hasOwnProperty.call(update.variables, row.key);
              return (
                <div key={row.key} className="flex items-start gap-4 p-4">
                  <div className="mt-1 grid h-8 w-8 place-items-center rounded-md bg-muted">{row.icon}</div>
                  <div className="flex-1 min-w-0">
                    <Label htmlFor={inputId} className={readOnly ? "" : "cursor-pointer"}>{row.label}</Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">{row.description}</p>
                  </div>
                  <div className="flex items-center gap-2 pt-0.5">
                    {isUpdatingThis && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                    <Switch
                      id={inputId}
                      checked={checked}
                      disabled={readOnly}
                      onCheckedChange={(value) => update.mutate({ [row.key]: value } as Partial<GlobalSettings>)}
                      aria-label={row.label}
                    />
                  </div>
                </div>
              );
            })}
        </div>
      </CardContent>
    </Card>
  );
}

function BccAndFormsCard({ readOnly }: { readOnly: boolean }) {
  const settings = useSettings();
  const update = useUpdate();
  const [formConfig, setFormConfig] = useState({
    maxDailyHours: "12",
    approval: "Manager approval",
    mandatory: "Project, activity, date, time, task"
  });

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MailCheck className="h-4 w-4 text-primary" />
            BCC behavior
          </CardTitle>
          <CardDescription>
            Optionally BCC every active super admin on outbound transactional email. Useful for compliance & training visibility.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-4 rounded-lg border border-border bg-muted/30 p-4">
            <div className="mt-1 grid h-8 w-8 place-items-center rounded-md bg-muted">
              <ShieldCheck className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <Label htmlFor="bcc-admin" className={readOnly ? "" : "cursor-pointer"}>
                BCC super admin on all outbound emails
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                When enabled, every welcome / reset / submission / approval / SLA / reminder email also delivers a silent copy to each
                active super admin. The recipient never sees the BCC list.
              </p>
            </div>
            {settings.isLoading ? (
              <Skeleton className="h-6 w-11 rounded-full" />
            ) : (
              <Switch
                id="bcc-admin"
                checked={Boolean(settings.data?.bccSuperAdminOnAllEmails)}
                disabled={readOnly}
                onCheckedChange={(checked) => update.mutate({ bccSuperAdminOnAllEmails: checked })}
              />
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Timesheet validation</CardTitle>
          <CardDescription>Applies to every new timesheet across the workspace.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label>Max daily hours</Label>
              <Input value={formConfig.maxDailyHours} onChange={(e) => setFormConfig({ ...formConfig, maxDailyHours: e.target.value })} disabled={readOnly} />
            </div>
            <div className="grid gap-1.5">
              <Label>Approval workflow</Label>
              <Input value={formConfig.approval} onChange={(e) => setFormConfig({ ...formConfig, approval: e.target.value })} disabled={readOnly} />
            </div>
            <div className="grid gap-1.5">
              <Label>Mandatory fields</Label>
              <Input value={formConfig.mandatory} onChange={(e) => setFormConfig({ ...formConfig, mandatory: e.target.value })} disabled={readOnly} />
            </div>
          </div>
          <Button
            disabled={readOnly}
            className="self-start"
            onClick={() => toast.success("Configuration saved", { description: "Persisted locally for this demo build." })}
          >
            <Save />Save configuration
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function TicketingSettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "ticketing"], queryFn: settingsApi.getTicketing });
  const [sla, setSla] = useState<Pick<GlobalTicketSettings, "slaLowHours" | "slaMediumHours" | "slaHighHours" | "slaCriticalHours"> | null>(null);

  useEffect(() => {
    if (settings.data) {
      setSla({
        slaLowHours: settings.data.slaLowHours,
        slaMediumHours: settings.data.slaMediumHours,
        slaHighHours: settings.data.slaHighHours,
        slaCriticalHours: settings.data.slaCriticalHours
      });
    }
  }, [settings.data]);

  const update = useMutation({
    mutationFn: (payload: Partial<GlobalTicketSettings>) => settingsApi.updateTicketing(payload),
    onSuccess: () => {
      toast.success("Saved");
      queryClient.invalidateQueries({ queryKey: ["settings", "ticketing"] });
    },
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });

  const types = useQuery({ queryKey: ["ticket-types", "all"], queryFn: () => ticketTypeApi.list(true) });
  const [newType, setNewType] = useState({ name: "", color: "#3B82F6" });
  const createType = useMutation({
    mutationFn: () => ticketTypeApi.create(newType),
    onSuccess: () => {
      toast.success("Type added");
      setNewType({ name: "", color: "#3B82F6" });
      queryClient.invalidateQueries({ queryKey: ["ticket-types"] });
    },
    onError: (err: any) => toast.error("Could not add type", { description: err?.response?.data?.message ?? "Try again." })
  });
  const toggleType = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => ticketTypeApi.update(id, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ticket-types"] }),
    onError: (err: any) => toast.error("Could not update type", { description: err?.response?.data?.message ?? "Try again." })
  });

  const labels = useQuery({ queryKey: ["labels"], queryFn: labelApi.list });
  const [newLabel, setNewLabel] = useState({ name: "", color: "#8B5CF6" });
  const createLabel = useMutation({
    mutationFn: () => labelApi.create(newLabel),
    onSuccess: () => {
      toast.success("Label added");
      setNewLabel({ name: "", color: "#8B5CF6" });
      queryClient.invalidateQueries({ queryKey: ["labels"] });
    },
    onError: (err: any) => toast.error("Could not add label", { description: err?.response?.data?.message ?? "Try again." })
  });
  const removeLabel = useMutation({
    mutationFn: (id: string) => labelApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["labels"] }),
    onError: (err: any) => toast.error("Could not remove label", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Timer className="h-4 w-4 text-primary" />
            Ticket SLA hours
          </CardTitle>
          <CardDescription>
            How many hours a ticket has to be resolved before it's flagged overdue and escalated, by priority.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {(settings.isLoading || !sla) ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-4">
                <div className="grid gap-1.5">
                  <Label>Low</Label>
                  <Input type="number" min={1} value={sla.slaLowHours} disabled={readOnly} onChange={(e) => setSla({ ...sla, slaLowHours: Number(e.target.value) })} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Medium</Label>
                  <Input type="number" min={1} value={sla.slaMediumHours} disabled={readOnly} onChange={(e) => setSla({ ...sla, slaMediumHours: Number(e.target.value) })} />
                </div>
                <div className="grid gap-1.5">
                  <Label>High</Label>
                  <Input type="number" min={1} value={sla.slaHighHours} disabled={readOnly} onChange={(e) => setSla({ ...sla, slaHighHours: Number(e.target.value) })} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Critical</Label>
                  <Input type="number" min={1} value={sla.slaCriticalHours} disabled={readOnly} onChange={(e) => setSla({ ...sla, slaCriticalHours: Number(e.target.value) })} />
                </div>
              </div>
              {!readOnly && (
                <Button size="sm" className="justify-self-start" disabled={update.isPending} onClick={() => sla && update.mutate(sla)}>
                  <Save className="h-4 w-4" />Save SLA hours
                </Button>
              )}
              <Separator />
              <div className="flex items-start gap-4 rounded-lg border border-border bg-muted/30 p-4">
                <div className="flex-1">
                  <Label>Cost analytics</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">Requires hourly rates on user profiles. Off by default.</p>
                </div>
                <Switch checked={settings.data?.enableCostAnalytics ?? false} disabled={readOnly} onCheckedChange={(v) => update.mutate({ enableCostAnalytics: v })} />
              </div>
              <div className="flex items-start gap-4 rounded-lg border border-border bg-muted/30 p-4">
                <div className="flex-1">
                  <Label>Team leaderboard</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">Resolved-ticket rankings on the Insights page. Off by default.</p>
                </div>
                <Switch checked={settings.data?.enableLeaderboard ?? false} disabled={readOnly} onCheckedChange={(v) => update.mutate({ enableLeaderboard: v })} />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ticket types</CardTitle>
          <CardDescription>Bug/Task/Improvement are seeded defaults — add your own or retire ones you don't use.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!readOnly && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid gap-1.5">
                <Label className="text-xs">Name</Label>
                <Input className="w-48" value={newType.name} onChange={(e) => setNewType({ ...newType, name: e.target.value })} placeholder="e.g. Support Request" />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Color</Label>
                <Input type="color" className="h-9 w-14 p-1" value={newType.color} onChange={(e) => setNewType({ ...newType, color: e.target.value })} />
              </div>
              <Button size="sm" disabled={!newType.name.trim() || createType.isPending} onClick={() => createType.mutate()}>
                <Plus className="h-4 w-4" />Add type
              </Button>
            </div>
          )}
          <div className="divide-y divide-border rounded-lg border border-border">
            {(types.data ?? []).map((t) => (
              <div key={t.id} className="flex items-center gap-3 p-3">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: t.color ?? "#94A3B8" }} />
                <span className="flex-1 text-sm font-medium">{t.name}</span>
                <Badge variant={t.isActive ? "success" : "muted"}>{t.isActive ? "Active" : "Inactive"}</Badge>
                {!readOnly && <Switch checked={t.isActive} onCheckedChange={(v) => toggleType.mutate({ id: t.id, isActive: v })} />}
              </div>
            ))}
            {(types.data ?? []).length === 0 && <p className="p-3 text-sm text-muted-foreground">No ticket types yet.</p>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Labels</CardTitle>
          <CardDescription>Cross-cutting tags for tickets (e.g. "regression", "customer-reported").</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!readOnly && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid gap-1.5">
                <Label className="text-xs">Name</Label>
                <Input className="w-48" value={newLabel.name} onChange={(e) => setNewLabel({ ...newLabel, name: e.target.value })} placeholder="e.g. regression" />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Color</Label>
                <Input type="color" className="h-9 w-14 p-1" value={newLabel.color} onChange={(e) => setNewLabel({ ...newLabel, color: e.target.value })} />
              </div>
              <Button size="sm" disabled={!newLabel.name.trim() || createLabel.isPending} onClick={() => createLabel.mutate()}>
                <Plus className="h-4 w-4" />Add label
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {(labels.data ?? []).map((l) => (
              <span key={l.id} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color ?? "#94A3B8" }} />
                {l.name}
                {!readOnly && (
                  <button type="button" onClick={() => removeLabel.mutate(l.id)} className="ml-1 text-muted-foreground hover:text-destructive">
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            ))}
            {(labels.data ?? []).length === 0 && <p className="text-sm text-muted-foreground">No labels yet.</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AISettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "ai"], queryFn: settingsApi.getAI });
  const usage = useQuery({
    queryKey: ["settings", "ai", "usage"],
    queryFn: settingsApi.getAIUsageSummary,
    enabled: Boolean(settings.data?.aiEnabled)
  });

  const update = useMutation({
    mutationFn: (payload: Partial<GlobalAISettings>) => settingsApi.updateAI(payload),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: ["settings", "ai"] });
      const previous = queryClient.getQueryData<GlobalAISettings>(["settings", "ai"]);
      if (previous) queryClient.setQueryData(["settings", "ai"], { ...previous, ...payload });
      return { previous };
    },
    onError: (err: any, _payload, context) => {
      if (context?.previous) queryClient.setQueryData(["settings", "ai"], context.previous);
      toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "ai"] })
  });

  const [budgetDraft, setBudgetDraft] = useState("");
  useEffect(() => {
    if (settings.data) setBudgetDraft(settings.data.monthlyBudgetUsd != null ? String(settings.data.monthlyBudgetUsd) : "");
  }, [settings.data?.monthlyBudgetUsd]);

  const toggles: Array<{ key: keyof GlobalAISettings; label: string; description: string }> = [
    { key: "autoTriageEnabled", label: "Auto-triage suggestions", description: "Suggest type, priority, and module when a ticket is created." },
    { key: "autoTriageAutoApply", label: "Auto-apply triage suggestions", description: "Pre-fill the suggestion instead of showing an accept/dismiss chip." },
    { key: "duplicateDetectionEnabled", label: "Duplicate detection", description: "Flag likely-duplicate tickets when a new one is created." },
    { key: "writingAssistantEnabled", label: "Writing assistant", description: "\"Improve with AI\" button in ticket and comment editors." },
    { key: "commentSummaryEnabled", label: "Comment thread summaries", description: "AI summary of long comment threads on a ticket." },
    { key: "workspaceSearchEnabled", label: "\"Ask AI\" ticket search", description: "Natural-language Q&A over your accessible tickets from the command palette." },
    { key: "emailIngestionEnabled", label: "Email-to-ticket intake", description: "Parse inbound bug-report emails and auto-create tickets." },
    { key: "weeklyDigestEnabled", label: "AI weekly digest", description: "LLM-authored weekly summary of ticket + timesheet activity." }
  ];

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            AI features
          </CardTitle>
          <CardDescription>
            Every AI feature stays off until you enable it here — nothing calls out to Anthropic otherwise.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {settings.isLoading && <Skeleton className="h-40 w-full" />}
          {!settings.isLoading && settings.data && (
            <>
              {!settings.data.apiKeyConfigured && (
                <Alert variant="warning">
                  <ShieldAlert />
                  <AlertTitle>No API key configured</AlertTitle>
                  <AlertDescription>
                    Set <code className="rounded bg-background/60 px-1">ANTHROPIC_API_KEY</code> in{" "}
                    <code className="rounded bg-background/60 px-1">apps/api/.env</code> and restart the API — toggles below
                    will save, but nothing will actually run until then.
                  </AlertDescription>
                </Alert>
              )}
              <div className="flex items-start gap-4 rounded-lg border border-primary/40 bg-primary/5 p-4">
                <div className="flex-1">
                  <Label>Enable AI features</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">Master switch for everything below.</p>
                </div>
                <Switch checked={settings.data.aiEnabled} disabled={readOnly} onCheckedChange={(v) => update.mutate({ aiEnabled: v })} />
              </div>

              <div className="divide-y divide-border rounded-lg border border-border">
                {toggles.map((t) => (
                  <div key={t.key} className="flex items-start gap-4 p-4">
                    <div className="min-w-0 flex-1">
                      <Label className={readOnly ? "" : "cursor-pointer"}>{t.label}</Label>
                      <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>
                    </div>
                    <Switch
                      checked={Boolean(settings.data?.[t.key])}
                      disabled={readOnly || !settings.data?.aiEnabled}
                      onCheckedChange={(v) => update.mutate({ [t.key]: v } as Partial<GlobalAISettings>)}
                    />
                  </div>
                ))}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>Model</Label>
                  <Select value={settings.data.model} onValueChange={(v) => update.mutate({ model: v })} disabled={readOnly}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {aiModels.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label>Confidence threshold</Label>
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.data.confidenceThreshold}
                    disabled={readOnly}
                    onChange={(e) => update.mutate({ confidenceThreshold: Number(e.target.value) })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Below this, AI-classified tickets are flagged "needs review" instead of auto-assigned.
                  </p>
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label>Monthly budget (USD, optional)</Label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    placeholder="No cap"
                    value={budgetDraft}
                    disabled={readOnly}
                    onChange={(e) => setBudgetDraft(e.target.value)}
                  />
                  <Button
                    size="sm"
                    disabled={readOnly}
                    onClick={() => update.mutate({ monthlyBudgetUsd: budgetDraft ? Number(budgetDraft) : null })}
                  >
                    <Save className="h-4 w-4" />Save
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  AI features pause gracefully once this month's estimated spend hits the cap.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {settings.data?.aiEnabled && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">This month's usage</CardTitle>
            <CardDescription>Estimated cost from {usage.data?.monthStart ?? "this month"}.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {usage.isLoading && <Skeleton className="h-20 w-full" />}
            {!usage.isLoading && usage.data && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-lg border border-border bg-muted/30 p-4">
                    <p className="text-xs uppercase text-muted-foreground">Estimated spend</p>
                    <p className="mt-1 text-2xl font-black">${usage.data.totalCostUsd.toFixed(2)}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 p-4">
                    <p className="text-xs uppercase text-muted-foreground">AI calls</p>
                    <p className="mt-1 text-2xl font-black">{usage.data.totalCalls}</p>
                  </div>
                </div>
                {usage.data.byFeature.length > 0 && (
                  <div className="divide-y divide-border rounded-lg border border-border">
                    {usage.data.byFeature.map((f) => (
                      <div key={f.feature} className="flex items-center justify-between p-3 text-sm">
                        <span>{f.feature}</span>
                        <span className="text-muted-foreground">{f.calls} calls · ${f.costUsd.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {usage.data.byFeature.length === 0 && <p className="text-sm text-muted-foreground">No AI calls yet this month.</p>}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface ConnectionDraft {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUser: string;
  imapPassword: string;
  pollIntervalMinutes: number;
  fallbackProjectId: string;
}

function EmailIntakeSettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "email-intake"], queryFn: emailIntakeApi.getSettings });
  const projects = useQuery({ queryKey: ["projects"], queryFn: projectApi.list });
  const users = useQuery({ queryKey: ["users"], queryFn: userApi.list });
  const routingRules = useQuery({ queryKey: ["email-intake", "routing-rules"], queryFn: emailIntakeApi.routingRules.list });
  const assigneeRules = useQuery({ queryKey: ["email-intake", "assignee-rules"], queryFn: emailIntakeApi.assigneeRules.list });

  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  useEffect(() => {
    if (settings.data) {
      setDraft({
        imapHost: settings.data.imapHost ?? "",
        imapPort: settings.data.imapPort,
        imapSecure: settings.data.imapSecure,
        imapUser: settings.data.imapUser ?? "",
        imapPassword: "",
        pollIntervalMinutes: settings.data.pollIntervalMinutes,
        fallbackProjectId: settings.data.fallbackProjectId ?? ""
      });
    }
  }, [settings.data]);

  const update = useMutation({
    mutationFn: () =>
      emailIntakeApi.updateSettings({
        imapHost: draft!.imapHost || null,
        imapPort: draft!.imapPort,
        imapSecure: draft!.imapSecure,
        imapUser: draft!.imapUser || null,
        imapPassword: draft!.imapPassword || undefined,
        pollIntervalMinutes: draft!.pollIntervalMinutes,
        fallbackProjectId: draft!.fallbackProjectId || null
      }),
    onSuccess: () => {
      toast.success("Saved");
      setDraft((d) => (d ? { ...d, imapPassword: "" } : d));
      queryClient.invalidateQueries({ queryKey: ["settings", "email-intake"] });
    },
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });

  const testConnection = useMutation({
    mutationFn: () =>
      emailIntakeApi.testConnection(
        draft
          ? {
              host: draft.imapHost || undefined,
              port: draft.imapPort,
              secure: draft.imapSecure,
              user: draft.imapUser || undefined,
              password: draft.imapPassword || undefined
            }
          : undefined
      ),
    onSuccess: (res) => {
      if (res.ok) toast.success("Connection succeeded");
      else toast.error("Connection failed", { description: res.error });
    },
    onError: (err: any) => toast.error("Could not test connection", { description: err?.response?.data?.message ?? "Try again." })
  });

  const [newRule, setNewRule] = useState({ matchType: "TO_ADDRESS" as EmailMatchType, matchValue: "", projectId: "", defaultModuleId: "" });
  const createRule = useMutation({
    mutationFn: () =>
      emailIntakeApi.routingRules.create({
        matchType: newRule.matchType,
        matchValue: newRule.matchValue,
        projectId: newRule.projectId,
        defaultModuleId: newRule.defaultModuleId || undefined
      }),
    onSuccess: () => {
      toast.success("Routing rule added");
      setNewRule({ matchType: "TO_ADDRESS", matchValue: "", projectId: "", defaultModuleId: "" });
      queryClient.invalidateQueries({ queryKey: ["email-intake", "routing-rules"] });
    },
    onError: (err: any) => toast.error("Could not add rule", { description: err?.response?.data?.message ?? "Try again." })
  });
  const toggleRule = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => emailIntakeApi.routingRules.update(id, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["email-intake", "routing-rules"] }),
    onError: (err: any) => toast.error("Could not update rule", { description: err?.response?.data?.message ?? "Try again." })
  });
  const removeRule = useMutation({
    mutationFn: (id: string) => emailIntakeApi.routingRules.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["email-intake", "routing-rules"] }),
    onError: (err: any) => toast.error("Could not remove rule", { description: err?.response?.data?.message ?? "Try again." })
  });

  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ matchType: "TO_ADDRESS" as EmailMatchType, matchValue: "", projectId: "", defaultModuleId: "" });
  function startEditRule(rule: { id: string; matchType: EmailMatchType; matchValue: string; projectId: string; defaultModuleId: string | null }) {
    setEditingRuleId(rule.id);
    setEditDraft({ matchType: rule.matchType, matchValue: rule.matchValue, projectId: rule.projectId, defaultModuleId: rule.defaultModuleId ?? "" });
  }
  const saveEditRule = useMutation({
    mutationFn: () =>
      emailIntakeApi.routingRules.update(editingRuleId as string, {
        matchType: editDraft.matchType,
        matchValue: editDraft.matchValue,
        projectId: editDraft.projectId,
        defaultModuleId: editDraft.defaultModuleId || null
      }),
    onSuccess: () => {
      toast.success("Routing rule updated");
      setEditingRuleId(null);
      queryClient.invalidateQueries({ queryKey: ["email-intake", "routing-rules"] });
    },
    onError: (err: any) => toast.error("Could not update rule", { description: err?.response?.data?.message ?? "Try again." })
  });

  const [newAssignee, setNewAssignee] = useState({ projectId: "", moduleId: "", defaultAssigneeId: "" });
  const selectedProjectForAssignee = (projects.data ?? []).find((p: any) => p.id === newAssignee.projectId);
  const saveAssigneeRule = useMutation({
    mutationFn: () => emailIntakeApi.assigneeRules.save({ moduleId: newAssignee.moduleId, defaultAssigneeId: newAssignee.defaultAssigneeId }),
    onSuccess: () => {
      toast.success("Assignee rule saved");
      setNewAssignee({ projectId: "", moduleId: "", defaultAssigneeId: "" });
      queryClient.invalidateQueries({ queryKey: ["email-intake", "assignee-rules"] });
    },
    onError: (err: any) => toast.error("Could not save rule", { description: err?.response?.data?.message ?? "Try again." })
  });
  const removeAssigneeRule = useMutation({
    mutationFn: (id: string) => emailIntakeApi.assigneeRules.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["email-intake", "assignee-rules"] }),
    onError: (err: any) => toast.error("Could not remove rule", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Inbox className="h-4 w-4 text-primary" />
            Mailbox connection
          </CardTitle>
          <CardDescription>
            IMAP mailbox polled for inbound bug-report emails. Master switch is the "Email-to-ticket intake" toggle on the AI tab.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {settings.isLoading || !draft ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <>
              {settings.data?.lastPollError && (
                <Alert variant="destructive">
                  <ShieldAlert />
                  <AlertTitle>Last poll failed</AlertTitle>
                  <AlertDescription>{settings.data.lastPollError}</AlertDescription>
                </Alert>
              )}
              {settings.data?.lastPolledAt && !settings.data.lastPollError && (
                <p className="text-xs text-muted-foreground">Last polled {new Date(settings.data.lastPolledAt).toLocaleString()}</p>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>IMAP host</Label>
                  <Input value={draft.imapHost} disabled={readOnly} onChange={(e) => setDraft({ ...draft, imapHost: e.target.value })} placeholder="imap.gmail.com" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Port</Label>
                  <Input type="number" value={draft.imapPort} disabled={readOnly} onChange={(e) => setDraft({ ...draft, imapPort: Number(e.target.value) })} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Username</Label>
                  <Input value={draft.imapUser} disabled={readOnly} onChange={(e) => setDraft({ ...draft, imapUser: e.target.value })} placeholder="bugs@yourcompany.com" />
                </div>
                <div className="grid gap-1.5">
                  <Label>
                    Password / app password{" "}
                    {settings.data?.imapPasswordSet && <span className="font-normal text-muted-foreground">(saved — leave blank to keep)</span>}
                  </Label>
                  <Input
                    type="password"
                    value={draft.imapPassword}
                    disabled={readOnly}
                    onChange={(e) => setDraft({ ...draft, imapPassword: e.target.value })}
                    placeholder={settings.data?.imapPasswordSet ? "••••••••" : ""}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Poll interval (minutes)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={draft.pollIntervalMinutes}
                    disabled={readOnly}
                    onChange={(e) => setDraft({ ...draft, pollIntervalMinutes: Number(e.target.value) })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>
                    Fallback project <span className="text-muted-foreground">(no routing rule match)</span>
                  </Label>
                  <Select
                    value={draft.fallbackProjectId || "none"}
                    onValueChange={(v) => setDraft({ ...draft, fallbackProjectId: v === "none" ? "" : v })}
                    disabled={readOnly}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None — drop unmatched mail</SelectItem>
                      {(projects.data ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex items-center gap-4 rounded-lg border border-border bg-muted/30 p-4">
                <div className="flex-1">
                  <Label>Use TLS (secure)</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">Almost always on for port 993.</p>
                </div>
                <Switch checked={draft.imapSecure} disabled={readOnly} onCheckedChange={(v) => setDraft({ ...draft, imapSecure: v })} />
              </div>
              {!readOnly && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={update.isPending} onClick={() => update.mutate()}>
                    <Save className="h-4 w-4" />Save
                  </Button>
                  <Button size="sm" variant="outline" disabled={testConnection.isPending} onClick={() => testConnection.mutate()}>
                    <PlugZap className="h-4 w-4" />Test connection
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Routing rules</CardTitle>
          <CardDescription>First active match (in creation order) wins. No match falls back to the project above.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!readOnly && (
            <div className="grid gap-2 sm:grid-cols-5 sm:items-end">
              <div className="grid gap-1.5">
                <Label className="text-xs">Match on</Label>
                <Select value={newRule.matchType} onValueChange={(v) => setNewRule({ ...newRule, matchType: v as EmailMatchType })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {emailMatchTypes.map((t) => <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Value</Label>
                <Input
                  value={newRule.matchValue}
                  onChange={(e) => setNewRule({ ...newRule, matchValue: e.target.value })}
                  placeholder={newRule.matchType === "SUBJECT_PREFIX" ? "[BUG]" : newRule.matchType === "TO_PLUS_TAG" ? "bugs" : "bugs@yourcompany.com"}
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Project</Label>
                <Select value={newRule.projectId} onValueChange={(v) => setNewRule({ ...newRule, projectId: v, defaultModuleId: "" })}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {(projects.data ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">
                  Default module <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Select
                  value={newRule.defaultModuleId}
                  onValueChange={(v) => setNewRule({ ...newRule, defaultModuleId: v })}
                  disabled={!newRule.projectId}
                >
                  <SelectTrigger><SelectValue placeholder="Any" /></SelectTrigger>
                  <SelectContent>
                    {(projects.data ?? [])
                      .find((p: any) => p.id === newRule.projectId)
                      ?.modules?.map((m: any) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Button size="sm" disabled={!newRule.matchValue.trim() || !newRule.projectId || createRule.isPending} onClick={() => createRule.mutate()}>
                <Plus className="h-4 w-4" />Add rule
              </Button>
            </div>
          )}
          <div className="divide-y divide-border rounded-lg border border-border">
            {(routingRules.data ?? []).map((rule) =>
              editingRuleId === rule.id ? (
                <div key={rule.id} className="grid gap-2 p-3 sm:grid-cols-5 sm:items-end">
                  <Select value={editDraft.matchType} onValueChange={(v) => setEditDraft({ ...editDraft, matchType: v as EmailMatchType })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {emailMatchTypes.map((t) => <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input value={editDraft.matchValue} onChange={(e) => setEditDraft({ ...editDraft, matchValue: e.target.value })} />
                  <Select value={editDraft.projectId} onValueChange={(v) => setEditDraft({ ...editDraft, projectId: v, defaultModuleId: "" })}>
                    <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                    <SelectContent>
                      {(projects.data ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select value={editDraft.defaultModuleId} onValueChange={(v) => setEditDraft({ ...editDraft, defaultModuleId: v })}>
                    <SelectTrigger><SelectValue placeholder="Any module" /></SelectTrigger>
                    <SelectContent>
                      {(projects.data ?? [])
                        .find((p: any) => p.id === editDraft.projectId)
                        ?.modules?.map((m: any) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={!editDraft.matchValue.trim() || !editDraft.projectId || saveEditRule.isPending} onClick={() => saveEditRule.mutate()}>
                      <Check className="h-4 w-4" />Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingRuleId(null)}>
                      <X className="h-4 w-4" />Cancel
                    </Button>
                  </div>
                </div>
              ) : (
              <div key={rule.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <Badge variant="muted">{rule.matchType.replace(/_/g, " ")}</Badge>
                <span className="font-mono text-xs">{rule.matchValue}</span>
                <span className="flex-1 text-muted-foreground">
                  &rarr; {rule.project.name}
                  {rule.defaultModule ? ` / ${rule.defaultModule.name}` : ""}
                </span>
                {!readOnly && (
                  <>
                    <Switch checked={rule.isActive} onCheckedChange={(v) => toggleRule.mutate({ id: rule.id, isActive: v })} />
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEditRule(rule)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => removeRule.mutate(rule.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </div>
              )
            )}
            {(routingRules.data ?? []).length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">No routing rules yet — inbound mail lands in the fallback project.</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Module auto-assignment</CardTitle>
          <CardDescription>
            Once a module is resolved for an email-sourced ticket, assign it to this person automatically — only when it isn't flagged "needs review".
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!readOnly && (
            <div className="grid gap-2 sm:grid-cols-4 sm:items-end">
              <div className="grid gap-1.5">
                <Label className="text-xs">Project</Label>
                <Select value={newAssignee.projectId} onValueChange={(v) => setNewAssignee({ projectId: v, moduleId: "", defaultAssigneeId: "" })}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {(projects.data ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Module</Label>
                <Select
                  value={newAssignee.moduleId}
                  onValueChange={(v) => setNewAssignee({ ...newAssignee, moduleId: v })}
                  disabled={!newAssignee.projectId}
                >
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {selectedProjectForAssignee?.modules?.map((m: any) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Assignee</Label>
                <Select value={newAssignee.defaultAssigneeId} onValueChange={(v) => setNewAssignee({ ...newAssignee, defaultAssigneeId: v })}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {(users.data ?? []).map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Button
                size="sm"
                disabled={!newAssignee.moduleId || !newAssignee.defaultAssigneeId || saveAssigneeRule.isPending}
                onClick={() => saveAssigneeRule.mutate()}
              >
                <Plus className="h-4 w-4" />Save rule
              </Button>
            </div>
          )}
          <div className="divide-y divide-border rounded-lg border border-border">
            {(assigneeRules.data ?? []).map((rule) => (
              <div key={rule.id} className="flex items-center gap-3 p-3 text-sm">
                <span className="flex-1">{rule.module.name}</span>
                <span className="text-muted-foreground">&rarr; {rule.defaultAssignee.name}</span>
                {!readOnly && (
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => removeAssigneeRule.mutate(rule.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
            {(assigneeRules.data ?? []).length === 0 && <p className="p-3 text-sm text-muted-foreground">No auto-assignment rules yet.</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
