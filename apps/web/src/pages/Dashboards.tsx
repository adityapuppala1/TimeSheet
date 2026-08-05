/**
 * Custom dashboards — a grid of widgets someone arranges themselves, plus the scheduled
 * deliveries that mail one out.
 *
 * WHY THE WIDGET LIST IS A CLOSED CATALOGUE rather than a query builder: a dashboard people build
 * themselves is only trustworthy if every tile means the same thing on every dashboard. "Open
 * items" is one query defined on the server, so two dashboards showing it cannot legitimately
 * disagree — which is exactly what a generic pick-a-table-and-an-aggregate builder allows.
 *
 * WHY SHARING IS SAFE TO DO CASUALLY: a shared dashboard is a saved LAYOUT. Every widget resolves
 * against the viewer's own project scope, so two people opening the same dashboard see their own
 * permitted projects and publishing a layout can never publish data.
 *
 * WHO renders this: `App.tsx` at `/app/dashboards`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BarChart3,
  Copy,
  LayoutDashboard,
  Loader2,
  Mail,
  Plus,
  Save,
  Trash2
} from "lucide-react";
import { useEffect, useState } from "react";
import { permissions } from "@timesheet/shared";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { StatCard } from "../components/ui/stat-card";
import { Switch } from "../components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { toast } from "../components/ui/toaster";
import { cn } from "../lib/utils";
import { usePlanningFeatures } from "../lib/use-planning";
import { useAuthStore } from "../store/auth";
import { dashboardApi, type DashboardRow, type ResolvedWidget, type WidgetDescriptorRow } from "../services/api";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

/** One tile. Shape decides the component, never the widget type — a new STAT widget needs no UI. */
function Widget({ widget }: { widget: ResolvedWidget }) {
  if (widget.unavailable) {
    return (
      <Card>
        <CardContent className="grid h-full place-items-center gap-1 p-4 text-center">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{widget.title}</p>
          {/* Not a zero. A zero is a claim; "not available" is not. */}
          <p className="text-xs text-muted-foreground">{widget.unavailable}</p>
        </CardContent>
      </Card>
    );
  }

  if (widget.shape === "STAT") {
    return (
      <StatCard
        label={widget.title}
        value={
          <span className="flex flex-wrap items-baseline gap-1">
            {widget.value ?? "—"}
            {widget.unit && <span className="text-sm font-normal">{widget.unit}</span>}
          </span>
        }
        icon={<BarChart3 className="h-4 w-4" />}
      />
    );
  }

  if (widget.shape === "SERIES" || widget.shape === "BREAKDOWN") {
    const points = widget.points ?? [];
    const max = Math.max(1, ...points.map((p) => Math.max(p.value, p.secondary ?? 0)));
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{widget.title}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1.5">
          {points.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing in range.</p>
          ) : (
            points.map((point, i) => (
              <div key={`${point.label}-${i}`} className="grid gap-0.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="capitalize text-muted-foreground">{point.label}</span>
                  <span className="tabular-nums">
                    {point.value}
                    {point.secondary !== undefined && <span className="text-muted-foreground"> / {point.secondary}</span>}
                  </span>
                </div>
                {/* Two bars where a series carries a second number, so created-vs-resolved reads
                    as a comparison rather than as one bar with a caption. */}
                <div className="flex h-1.5 gap-0.5">
                  <div className="rounded-sm bg-primary" style={{ width: `${(point.value / max) * 100}%` }} />
                  {point.secondary !== undefined && (
                    <div className="rounded-sm bg-success" style={{ width: `${(point.secondary / max) * 100}%` }} />
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    );
  }

  const rows = widget.rows ?? [];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{widget.title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0 sm:p-0">
        {rows.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">Nothing to show.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {Object.keys(rows[0]).map((key) => (
                    <TableHead key={key} className="text-[11px] capitalize">
                      {key}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, i) => (
                  <TableRow key={i}>
                    {Object.values(row).map((value, j) => (
                      <TableCell key={j} className="text-xs">
                        {value ?? "—"}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardsPage() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const { features } = usePlanningFeatures();
  const canShare = Boolean(user?.permissions.includes(permissions.DASHBOARDS_SHARE));

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ name: string; scope: "PERSONAL" | "SHARED"; widgets: Array<{ id: string; type: string; title?: string }> }>({
    name: "",
    scope: "PERSONAL",
    widgets: []
  });

  const dashboards = useQuery({ queryKey: ["dashboards"], queryFn: dashboardApi.list, enabled: features.planning });
  const catalogue = useQuery({ queryKey: ["dashboards", "catalogue"], queryFn: dashboardApi.catalogue, enabled: features.planning });

  // Land on the person's default, or the first thing they can see, rather than an empty frame.
  useEffect(() => {
    if (selectedId || !dashboards.data?.length) return;
    setSelectedId((dashboards.data.find((d) => d.isDefault) ?? dashboards.data[0]).id);
  }, [dashboards.data, selectedId]);

  const data = useQuery({
    queryKey: ["dashboards", selectedId, "data"],
    queryFn: () => dashboardApi.data(selectedId!),
    enabled: Boolean(selectedId) && features.planning
  });

  const save = useMutation({
    mutationFn: () => {
      const payload = { name: draft.name.trim(), scope: draft.scope, widgets: draft.widgets as never[] };
      return selectedId && editing && dashboards.data?.some((d) => d.id === selectedId && d.ownerId === user?.id)
        ? dashboardApi.update(selectedId, payload)
        : dashboardApi.create(payload);
    },
    onSuccess: (saved: DashboardRow) => {
      toast.success("Dashboard saved");
      setEditing(false);
      setSelectedId(saved.id);
      queryClient.invalidateQueries({ queryKey: ["dashboards"] });
    },
    onError: (err: any) => toast.error("Could not save", { description: serverMessage(err, "Try again.") })
  });

  const remove = useMutation({
    mutationFn: (id: string) => dashboardApi.remove(id),
    onSuccess: () => {
      toast.success("Dashboard deleted");
      setSelectedId(null);
      queryClient.invalidateQueries({ queryKey: ["dashboards"] });
    },
    onError: (err: any) => toast.error("Could not delete", { description: serverMessage(err, "Try again.") })
  });

  const startNew = () => {
    setDraft({
      name: "",
      scope: "PERSONAL",
      // A useful default rather than an empty canvas — a blank grid makes someone guess what a
      // dashboard is even for.
      widgets: [
        { id: "w1", type: "OPEN_ITEMS" },
        { id: "w2", type: "OVERDUE_ITEMS" },
        { id: "w3", type: "HOURS_LOGGED" },
        { id: "w4", type: "RISK_BANDS" },
        { id: "w5", type: "VELOCITY" },
        { id: "w6", type: "MY_QUEUE" }
      ]
    });
    setEditing(true);
  };

  const startEdit = (dashboard: DashboardRow) => {
    setDraft({
      name: dashboard.name,
      scope: dashboard.scope,
      widgets: ((dashboard.widgets as unknown as Array<{ id: string; type: string; title?: string }>) ?? []).map((w) => ({ ...w }))
    });
    setEditing(true);
  };

  if (!features.planning) {
    return (
      <div className="mx-auto grid w-full max-w-3xl gap-4 p-4 sm:p-6">
        <Card>
          <CardContent className="grid gap-3 p-8 text-center">
            <LayoutDashboard className="mx-auto h-8 w-8 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Dashboards need the planning layer</h1>
            <p className="text-sm text-muted-foreground">A super admin can turn it on in Workspace Settings → Planning.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const selected = dashboards.data?.find((d) => d.id === selectedId);
  const isMine = selected?.ownerId === user?.id;

  return (
    <div className="grid min-w-0 gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <LayoutDashboard className="h-5 w-5 text-primary" />
            Dashboards
          </h1>
          <p className="text-sm text-muted-foreground">
            Build your own view. Shared dashboards show each person their own projects, so publishing a layout never
            publishes data.
          </p>
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          {(dashboards.data ?? []).length > 0 && (
            <Select value={selectedId ?? ""} onValueChange={setSelectedId}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Pick a dashboard" />
              </SelectTrigger>
              <SelectContent>
                {dashboards.data!.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                    {d.scope === "SHARED" ? " (shared)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button className="shrink-0" onClick={startNew}>
            <Plus className="h-4 w-4" />
            New
          </Button>
        </div>
      </div>

      <Tabs defaultValue="view" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
        <TabsList className="w-full justify-start sm:w-auto">
          <TabsTrigger value="view">Dashboard</TabsTrigger>
          <TabsTrigger value="deliveries">Scheduled delivery</TabsTrigger>
        </TabsList>

        <TabsContent value="view" className="grid gap-4">
          {editing ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{selected && isMine ? "Edit dashboard" : "New dashboard"}</CardTitle>
                <CardDescription>Pick the tiles you want. Every tile means the same thing on every dashboard.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label>Name</Label>
                    <Input value={draft.name} placeholder="Delivery overview" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Visibility</Label>
                    <label className="flex h-9 items-center gap-2 text-sm">
                      <Switch
                        checked={draft.scope === "SHARED"}
                        disabled={!canShare}
                        onCheckedChange={(v) => setDraft({ ...draft, scope: v ? "SHARED" : "PERSONAL" })}
                      />
                      {draft.scope === "SHARED" ? "Everyone in the workspace" : "Just me"}
                      {!canShare && <span className="text-xs text-muted-foreground">(needs the share permission)</span>}
                    </label>
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label className="text-xs uppercase text-muted-foreground">Tiles</Label>
                  <div className="grid gap-1.5">
                    {draft.widgets.map((widget, index) => (
                      <div key={widget.id} className="flex flex-wrap items-center gap-2 rounded border border-border p-2">
                        <Select
                          value={widget.type}
                          onValueChange={(v) =>
                            setDraft({ ...draft, widgets: draft.widgets.map((w, i) => (i === index ? { ...w, type: v } : w)) })
                          }
                        >
                          <SelectTrigger className="h-8 w-[240px] text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(catalogue.data ?? []).map((c: WidgetDescriptorRow) => (
                              <SelectItem key={c.type} value={c.type}>
                                {c.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <span className="text-xs text-muted-foreground">
                          {(catalogue.data ?? []).find((c) => c.type === widget.type)?.description}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto h-7 px-1.5"
                          onClick={() => setDraft({ ...draft, widgets: draft.widgets.filter((_, i) => i !== index) })}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="justify-self-start"
                    disabled={draft.widgets.length >= 24}
                    onClick={() =>
                      setDraft({ ...draft, widgets: [...draft.widgets, { id: `w${Date.now()}`, type: "OPEN_ITEMS" }] })
                    }
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    Add tile
                  </Button>
                </div>

                <div className="flex gap-2">
                  <Button disabled={!draft.name.trim() || draft.widgets.length === 0 || save.isPending} onClick={() => save.mutate()}>
                    {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    Save
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : !selectedId ? (
            <Card>
              <CardContent className="grid gap-2 p-10 text-center">
                <LayoutDashboard className="mx-auto h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium">No dashboards yet</p>
                <p className="text-xs text-muted-foreground">Build one from the tiles above.</p>
              </CardContent>
            </Card>
          ) : data.isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-28" />
              ))}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{selected?.name}</span>
                {selected?.scope === "SHARED" && <Badge variant="secondary">Shared</Badge>}
                {selected?.owner && !isMine && <span className="text-xs text-muted-foreground">by {selected.owner.name}</span>}
                {isMine && (
                  <>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => selected && startEdit(selected)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7" disabled={remove.isPending} onClick={() => remove.mutate(selected!.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
                {!isMine && selected && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7"
                    onClick={() => {
                      startEdit(selected);
                      setDraft((d) => ({ ...d, name: `${selected.name} copy`, scope: "PERSONAL" }));
                    }}
                  >
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                    Duplicate
                  </Button>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {(data.data?.widgets ?? []).map((widget) => (
                  <Widget key={widget.id} widget={widget} />
                ))}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="deliveries">
          <Deliveries dashboards={dashboards.data ?? []} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Deliveries({ dashboards }: { dashboards: DashboardRow[] }) {
  const queryClient = useQueryClient();
  const subscriptions = useQuery({ queryKey: ["dashboards", "subscriptions"], queryFn: dashboardApi.subscriptions });
  const [form, setForm] = useState({ name: "", dashboardId: "", cadence: "WEEKLY", hourUtc: "7", recipients: "" });

  const create = useMutation({
    mutationFn: () =>
      dashboardApi.createSubscription({
        name: form.name.trim(),
        dashboardId: form.dashboardId,
        cadence: form.cadence as never,
        hourUtc: Number(form.hourUtc),
        recipients: form.recipients.split(",").map((r) => r.trim()).filter(Boolean)
      }),
    onSuccess: () => {
      toast.success("Delivery scheduled");
      setForm({ name: "", dashboardId: "", cadence: "WEEKLY", hourUtc: "7", recipients: "" });
      queryClient.invalidateQueries({ queryKey: ["dashboards", "subscriptions"] });
    },
    onError: (err: any) => toast.error("Could not schedule", { description: serverMessage(err, "Try again.") })
  });

  const remove = useMutation({
    mutationFn: (id: string) => dashboardApi.removeSubscription(id),
    onSuccess: () => {
      toast.success("Delivery removed");
      queryClient.invalidateQueries({ queryKey: ["dashboards", "subscriptions"] });
    },
    onError: (err: any) => toast.error("Could not remove", { description: serverMessage(err, "Try again.") })
  });

  const recipients = form.recipients.split(",").map((r) => r.trim()).filter(Boolean);
  const invalid = !form.name.trim() || !form.dashboardId || recipients.length === 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Scheduled delivery</CardTitle>
        <CardDescription>
          Emails a dashboard on a schedule. Recipients don&apos;t need an account — the report is built with{" "}
          <span className="font-medium">your</span> access, so only send it to people you would show it to.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {subscriptions.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (subscriptions.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing scheduled.</p>
        ) : (
          <div className="grid gap-1.5">
            {subscriptions.data!.map((sub) => (
              <div key={sub.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-xs">
                <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium">{sub.name}</span>
                <Badge variant="outline">{sub.dashboard?.name}</Badge>
                <span className="text-muted-foreground">
                  {sub.cadence.toLowerCase()} at {String(sub.hourUtc).padStart(2, "0")}:00 UTC
                </span>
                <Badge variant="secondary">{(sub.recipients ?? []).length} recipient(s)</Badge>
                {!sub.isActive && <Badge variant="destructive">Paused</Badge>}
                {sub.lastSendError && (
                  <span className="inline-flex items-center gap-1 text-warning">
                    <AlertTriangle className="h-3 w-3" />
                    {sub.lastSendError}
                  </span>
                )}
                {sub.lastSentAt && <span className="text-muted-foreground">last sent {new Date(sub.lastSentAt).toLocaleDateString()}</span>}
                <Button size="sm" variant="ghost" className="ml-auto h-6 px-1.5" disabled={remove.isPending} onClick={() => remove.mutate(sub.id)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="grid gap-3 rounded-lg border border-dashed border-border p-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label className="text-xs">Name</Label>
            <Input value={form.name} placeholder="Monday delivery update" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Dashboard</Label>
            <Select value={form.dashboardId} onValueChange={(v) => setForm({ ...form, dashboardId: v })}>
              <SelectTrigger>
                <SelectValue placeholder="Pick one" />
              </SelectTrigger>
              <SelectContent>
                {dashboards.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">How often</Label>
            <Select value={form.cadence} onValueChange={(v) => setForm({ ...form, cadence: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DAILY">Every day</SelectItem>
                <SelectItem value="WEEKLY">Every Monday</SelectItem>
                <SelectItem value="MONTHLY">First of the month</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Hour (UTC)</Label>
            <Input type="number" min={0} max={23} value={form.hourUtc} onChange={(e) => setForm({ ...form, hourUtc: e.target.value })} />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label className="text-xs">Recipients</Label>
            <Input
              value={form.recipients}
              placeholder="client@example.com, sponsor@example.com"
              onChange={(e) => setForm({ ...form, recipients: e.target.value })}
            />
          </div>
          <Button className={cn("justify-self-start sm:col-span-2")} disabled={invalid || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
            Schedule
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
