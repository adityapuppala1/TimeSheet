/**
 * WHAT: the "Planning" tab in Workspace Settings — the V6 planning-layer master switches, the
 * working-week/capacity defaults, admin-defined custom fields, and the custom-workflow editor.
 * WHY split into its own file: same one-domain-per-file rule as every other card in this folder.
 *
 * WHY EVERY TOGGLE SHOWS ITS PLAN ENTITLEMENT NEXT TO IT: a switch that is on in the workspace
 * but not included in the org's plan is off in practice, because the API fails closed. Rendering
 * the switch alone would let an admin turn something on, see it stay on, and then find the
 * feature missing everywhere — the single most confusing failure a gated feature can have. So
 * the API returns `settings`, `entitlements` and the `effective` AND of the two in one response
 * (see planningApi.settings), and this card renders all three states distinctly: on, off, and
 * "on, but your plan doesn't include it".
 *
 * WHO calls the backing API: `controllers/planning.controller.ts`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarRange,
  GitBranch,
  Loader2,
  Lock,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
  Workflow as WorkflowIcon
} from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { toast } from "../../components/ui/toaster";
import {
  planningApi,
  ticketTypeApi,
  type CustomFieldRow,
  type PlanningConfig,
  type PlanningSettings,
  type WorkflowPayload,
  type WorkflowRow,
  type WorkStatusCategoryValue
} from "../../services/api";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const FIELD_TYPES = [
  { value: "TEXT", label: "Text" },
  { value: "NUMBER", label: "Number" },
  { value: "DATE", label: "Date" },
  { value: "SINGLE_SELECT", label: "Select (one)" },
  { value: "MULTI_SELECT", label: "Select (many)" },
  { value: "CHECKBOX", label: "Checkbox" },
  { value: "USER", label: "Person" },
  { value: "CURRENCY", label: "Currency" },
  { value: "URL", label: "Link" }
] as const;

/** Which categories read as "work is finished". Used only for the editor's colour hints. */
const CATEGORY_VARIANT: Record<WorkStatusCategoryValue, "secondary" | "info" | "warning" | "success" | "destructive"> = {
  TODO: "secondary",
  ACTIVE: "info",
  REVIEW: "warning",
  DONE: "success",
  CANCELLED: "destructive"
};

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

export function PlanningSettingsCard({ readOnly }: { readOnly: boolean }) {
  const config = useQuery({ queryKey: ["planning", "settings"], queryFn: planningApi.settings });

  if (config.isLoading || !config.data) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="grid min-w-0 gap-5">
      <PlanningTogglesCard readOnly={readOnly} config={config.data} />
      <WorkingWeekCard readOnly={readOnly} config={config.data} />
      <CustomFieldsCard readOnly={readOnly} config={config.data} />
      <WorkflowsCard readOnly={readOnly} config={config.data} />
    </div>
  );
}

/** One row: a switch, its explanation, and — when the plan doesn't include it — a lock. */
function ToggleRow({
  label,
  description,
  checked,
  entitled,
  disabled,
  onChange
}: {
  label: string;
  description: string;
  checked: boolean;
  /** False = the org's plan tier doesn't include this. The switch still moves (the preference is
   *  real and survives an upgrade), but the row says plainly that it does nothing today. */
  entitled: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          {!entitled && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary" className="gap-1">
                  <Lock className="h-3 w-3" />
                  Not in your plan
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Your preference is saved and takes effect the moment the plan includes this — but until then
                the API refuses the feature, so leaving the switch on changes nothing.
              </TooltipContent>
            </Tooltip>
          )}
          {checked && entitled && <Badge variant="success">Active</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function PlanningTogglesCard({ readOnly, config }: { readOnly: boolean; config: PlanningConfig }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<PlanningSettings>(config.settings);
  useEffect(() => setDraft(config.settings), [config.settings]);

  const update = useMutation({
    mutationFn: (patch: Partial<PlanningSettings>) => planningApi.updateSettings(patch),
    onSuccess: () => {
      toast.success("Saved");
      queryClient.invalidateQueries({ queryKey: ["planning"] });
    },
    onError: (err: any) => toast.error("Could not save", { description: serverMessage(err, "Try again.") })
  });

  const set = (key: keyof PlanningSettings, value: boolean) => {
    setDraft((d) => ({ ...d, [key]: value }));
    update.mutate({ [key]: value } as Partial<PlanningSettings>);
  };

  const { entitlements } = config;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarRange className="h-4 w-4 text-primary" />
          Planning layer
        </CardTitle>
        <CardDescription>
          Turns TimeSphere from an execution tracker into a project-management workspace: schedules, capacity,
          intake and approvals. Everything here is off by default — nothing about how your team works today
          changes until you turn one on.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <ToggleRow
          label="Planning & timeline"
          description="Work-item hierarchy (epics → tasks), start/end dates, dependencies, milestones and the Gantt timeline. Your existing tickets become top-level items — nothing is moved or renamed."
          checked={draft.enablePlanning}
          entitled={entitlements.ganttEnabled}
          disabled={readOnly || update.isPending}
          onChange={(v) => set("enablePlanning", v)}
        />
        <ToggleRow
          label="Resource management"
          description="Per-person capacity, bookings and the workload board. Reads the hours your team already logs, so planned-vs-actual is measured rather than estimated."
          checked={draft.enableResourceManagement}
          entitled={entitlements.resourceMgmtEnabled}
          disabled={readOnly || update.isPending}
          onChange={(v) => set("enableResourceManagement", v)}
        />
        <ToggleRow
          label="Approvals on work items"
          description="Multi-step approval chains on tickets, including external reviewers who don't have an account. Separate from timesheet approval, which is unchanged."
          checked={draft.enableApprovals}
          entitled={entitlements.approvalsEnabled}
          disabled={readOnly || update.isPending}
          onChange={(v) => set("enableApprovals", v)}
        />
        <ToggleRow
          label="Proofing & annotation"
          description="Pin comments directly onto an attached image or PDF instead of describing the spot in a comment."
          checked={draft.enableProofing}
          entitled={entitlements.proofingEnabled}
          disabled={readOnly || update.isPending}
          onChange={(v) => set("enableProofing", v)}
        />
        <ToggleRow
          label="Request forms"
          description="Intake forms with conditional questions that turn a request into a ticket. Can be internal, or published to a public link for people outside the workspace."
          checked={draft.enableRequestForms}
          entitled
          disabled={readOnly || update.isPending}
          onChange={(v) => set("enableRequestForms", v)}
        />
        <ToggleRow
          label="Custom workflows"
          description="Define your own statuses and transitions per ticket type. Every custom status still maps to a built-in one, so reports, SLAs and exports keep working exactly as they do now."
          checked={draft.enableCustomWorkflows}
          entitled={entitlements.customWorkflowsEnabled}
          disabled={readOnly || update.isPending}
          onChange={(v) => set("enableCustomWorkflows", v)}
        />
        <ToggleRow
          label="Goals"
          description="Objectives with key results, where progress is MEASURED from data this workspace already holds — approved hours, budget spend, tickets closed, on-time rate, SLA breaches or project risk — rather than typed in. A measured goal can still be overridden, and the override records who did it and what the measurement said at the time."
          checked={draft.enableGoals}
          entitled={entitlements.goalsEnabled}
          disabled={readOnly || update.isPending}
          onChange={(v) => set("enableGoals", v)}
        />
      </CardContent>
    </Card>
  );
}

function WorkingWeekCard({ readOnly, config }: { readOnly: boolean; config: PlanningConfig }) {
  const queryClient = useQueryClient();
  const [days, setDays] = useState<number[]>(config.settings.workingDays ?? [1, 2, 3, 4, 5]);
  const [capacity, setCapacity] = useState<string>(String(config.settings.defaultWeeklyCapacityHours ?? 40));

  useEffect(() => {
    setDays(config.settings.workingDays ?? [1, 2, 3, 4, 5]);
    setCapacity(String(config.settings.defaultWeeklyCapacityHours ?? 40));
  }, [config.settings]);

  const update = useMutation({
    mutationFn: () =>
      planningApi.updateSettings({ workingDays: days, defaultWeeklyCapacityHours: Number(capacity) }),
    onSuccess: () => {
      toast.success("Saved");
      queryClient.invalidateQueries({ queryKey: ["planning"] });
    },
    onError: (err: any) => toast.error("Could not save", { description: serverMessage(err, "Try again.") })
  });

  const toggleDay = (day: number) =>
    setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort()));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <SlidersHorizontal className="h-4 w-4 text-primary" />
          Working week
        </CardTitle>
        <CardDescription>
          Used by the timeline when it spreads a task's effort across days, and as the denominator for
          utilisation on the workload board. A six-day week produces genuinely different schedules from a
          five-day one, so this is worth getting right before you plan anything.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1.5">
          <Label>Working days</Label>
          <div className="flex flex-wrap gap-1.5">
            {DAY_LABELS.map((label, day) => (
              <Button
                key={label}
                type="button"
                size="sm"
                variant={days.includes(day) ? "default" : "outline"}
                disabled={readOnly}
                onClick={() => toggleDay(day)}
              >
                {label}
              </Button>
            ))}
          </div>
          {days.length === 0 && (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertTriangle className="h-3 w-3" />
              Pick at least one working day.
            </p>
          )}
        </div>

        <div className="grid max-w-xs gap-1.5">
          <Label>Default weekly capacity (hours)</Label>
          <Input
            type="number"
            min={1}
            max={168}
            step="0.5"
            value={capacity}
            disabled={readOnly}
            onChange={(e) => setCapacity(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Applies to anyone without their own capacity set on their profile.
          </p>
        </div>

        {!readOnly && (
          <Button
            size="sm"
            className="justify-self-start"
            disabled={update.isPending || days.length === 0}
            onClick={() => update.mutate()}
          >
            {update.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function CustomFieldsCard({ readOnly, config }: { readOnly: boolean; config: PlanningConfig }) {
  const queryClient = useQueryClient();
  const fields = useQuery({ queryKey: ["planning", "custom-fields", "all"], queryFn: () => planningApi.listCustomFields(true) });
  const ticketTypes = useQuery({ queryKey: ["ticket-types"], queryFn: () => ticketTypeApi.list() });

  const blank = {
    key: "",
    label: "",
    type: "TEXT" as string,
    options: "",
    appliesTo: "TICKET" as "TICKET" | "PROJECT",
    ticketTypeFilter: "",
    isRequired: false,
    showOnRequestForm: false
  };
  const [draft, setDraft] = useState(blank);

  const create = useMutation({
    mutationFn: () =>
      planningApi.createCustomField({
        key: draft.key.trim(),
        label: draft.label.trim(),
        type: draft.type,
        description: null,
        options: draft.options
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean),
        isRequired: draft.isRequired,
        appliesTo: draft.appliesTo,
        ticketTypeFilter: draft.ticketTypeFilter || null,
        showOnRequestForm: draft.showOnRequestForm,
        order: fields.data?.length ?? 0,
        isActive: true
      } as any),
    onSuccess: () => {
      toast.success("Field added");
      setDraft(blank);
      queryClient.invalidateQueries({ queryKey: ["planning", "custom-fields"] });
    },
    onError: (err: any) => toast.error("Could not add field", { description: serverMessage(err, "Try again.") })
  });

  const remove = useMutation({
    mutationFn: (id: string) => planningApi.deleteCustomField(id),
    onSuccess: (result) => {
      // The API deactivates instead of deleting when values exist — say so, rather than letting
      // the row reappear as "inactive" with no explanation.
      toast.success(result.deleted ? "Field removed" : "Field deactivated", {
        description: result.deleted ? undefined : "It had saved values, so it was hidden instead of deleted."
      });
      queryClient.invalidateQueries({ queryKey: ["planning", "custom-fields"] });
    },
    onError: (err: any) => toast.error("Could not remove field", { description: serverMessage(err, "Try again.") })
  });

  const needsOptions = draft.type === "SINGLE_SELECT" || draft.type === "MULTI_SELECT";
  const activeCount = (fields.data ?? []).filter((f) => f.isActive).length;
  const quota = config.entitlements.maxCustomFields;
  const atQuota = activeCount >= quota;

  // Key is derived from the label so an admin never has to think about it, but stays editable —
  // it is what request forms, blueprints and the public API address the field by, so it must be
  // stable across a later rename of the human label.
  const setLabel = (label: string) =>
    setDraft((d) => ({
      ...d,
      label,
      key: d.key || label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60)
    }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitBranch className="h-4 w-4 text-primary" />
          Custom fields
        </CardTitle>
        <CardDescription>
          Extra fields on tickets and projects — client name, cost centre, campaign, whatever your team tracks
          in a spreadsheet today. They're filterable and reportable, not free-text notes.
          {quota > 0 && quota < 1_000_000 && (
            <>
              {" "}
              <span className="font-medium">
                {activeCount} of {quota} used on your plan.
              </span>
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {fields.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (fields.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No custom fields yet.</p>
        ) : (
          <div className="grid gap-2">
            {fields.data!.map((f: CustomFieldRow) => (
              <div key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2.5">
                <div className="grid min-w-0 gap-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{f.label}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{f.key}</span>
                    <Badge variant="secondary">{FIELD_TYPES.find((t) => t.value === f.type)?.label ?? f.type}</Badge>
                    {f.appliesTo === "PROJECT" && <Badge variant="outline">Projects</Badge>}
                    {f.isRequired && <Badge variant="warning">Required</Badge>}
                    {!f.isActive && <Badge variant="outline">Inactive</Badge>}
                  </div>
                  {f.ticketTypeFilter && (
                    <p className="text-xs text-muted-foreground">Only on {f.ticketTypeFilter} tickets</p>
                  )}
                </div>
                {!readOnly && (
                  <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(f.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {!readOnly && (
          <div className="grid gap-3 rounded-lg border border-dashed border-border p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Label</Label>
                <Input value={draft.label} placeholder="Client name" onChange={(e) => setLabel(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>Key</Label>
                <Input
                  value={draft.key}
                  placeholder="client_name"
                  onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Type</Label>
                <Select value={draft.type} onValueChange={(v) => setDraft({ ...draft, type: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FIELD_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Applies to</Label>
                <Select
                  value={draft.appliesTo}
                  onValueChange={(v) => setDraft({ ...draft, appliesTo: v as "TICKET" | "PROJECT" })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TICKET">Tickets</SelectItem>
                    <SelectItem value="PROJECT">Projects</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {needsOptions && (
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label>Options (comma separated)</Label>
                  <Textarea
                    rows={2}
                    value={draft.options}
                    placeholder="Acme, Globex, Initech"
                    onChange={(e) => setDraft({ ...draft, options: e.target.value })}
                  />
                </div>
              )}
              {draft.appliesTo === "TICKET" && (
                <div className="grid gap-1.5">
                  <Label>Only on ticket type</Label>
                  <Select
                    value={draft.ticketTypeFilter || "__all__"}
                    onValueChange={(v) => setDraft({ ...draft, ticketTypeFilter: v === "__all__" ? "" : v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">Every type</SelectItem>
                      {(ticketTypes.data ?? []).map((t: any) => (
                        <SelectItem key={t.id} value={t.name}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="flex items-end gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={draft.isRequired}
                    onCheckedChange={(v) => setDraft({ ...draft, isRequired: v })}
                  />
                  Required
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={draft.showOnRequestForm}
                    onCheckedChange={(v) => setDraft({ ...draft, showOnRequestForm: v })}
                  />
                  On request forms
                </label>
              </div>
            </div>

            {atQuota && (
              <p className="flex items-center gap-1.5 text-xs text-warning">
                <Lock className="h-3 w-3" />
                {quota === 0
                  ? "Custom fields aren't included in your plan."
                  : `Your plan allows ${quota} active field(s). Deactivate one or upgrade.`}
              </p>
            )}

            <Button
              size="sm"
              className="justify-self-start"
              disabled={create.isPending || !draft.label.trim() || !draft.key.trim() || atQuota}
              onClick={() => create.mutate()}
            >
              {create.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Add field
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WorkflowsCard({ readOnly, config }: { readOnly: boolean; config: PlanningConfig }) {
  const queryClient = useQueryClient();
  const workflows = useQuery({ queryKey: ["planning", "workflows"], queryFn: planningApi.listWorkflows });
  const meta = useQuery({ queryKey: ["planning", "workflow-meta"], queryFn: planningApi.workflowMeta });

  const remove = useMutation({
    mutationFn: (id: string) => planningApi.deleteWorkflow(id),
    onSuccess: () => {
      toast.success("Workflow deleted");
      queryClient.invalidateQueries({ queryKey: ["planning", "workflows"] });
    },
    onError: (err: any) => toast.error("Could not delete", { description: serverMessage(err, "Try again.") })
  });

  const duplicate = useMutation({
    mutationFn: (source: WorkflowRow) => {
      const payload: WorkflowPayload = {
        name: `${source.name} copy`,
        description: source.description,
        appliesToTicketType: null,
        isDefault: false,
        isActive: true,
        statuses: source.statuses
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((s) => ({
            name: s.name,
            category: s.category,
            legacyStatus: s.legacyStatus,
            color: s.color,
            isInitial: s.isInitial,
            isFinal: s.isFinal
          })),
        transitions: source.transitions.map((t) => ({
          from: source.statuses.find((s) => s.id === t.fromStatusId)!.name,
          to: source.statuses.find((s) => s.id === t.toStatusId)!.name,
          requiresApproval: t.requiresApproval,
          requiredPermission: t.requiredPermission
        }))
      };
      return planningApi.createWorkflow(payload);
    },
    onSuccess: () => {
      toast.success("Workflow duplicated", { description: "Rename it and edit its statuses." });
      queryClient.invalidateQueries({ queryKey: ["planning", "workflows"] });
    },
    onError: (err: any) => toast.error("Could not duplicate", { description: serverMessage(err, "Try again.") })
  });

  const entitled = config.entitlements.customWorkflowsEnabled;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <WorkflowIcon className="h-4 w-4 text-primary" />
          Workflows
        </CardTitle>
        <CardDescription>
          The statuses a ticket moves through. Every custom status declares which built-in status it behaves
          like, so your SLAs, reports, exports and integrations keep reading the same values they always have —
          renaming "In review" to "Legal review" changes the board, not the data.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!entitled && (
          <p className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 p-2.5 text-xs text-muted-foreground">
            <Lock className="h-3.5 w-3.5 shrink-0" />
            Custom workflows are an Enterprise feature. The Default workflow below is always in force and is
            exactly the behaviour this workspace has today.
          </p>
        )}

        {workflows.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <div className="grid gap-2">
            {(workflows.data ?? []).map((wf) => (
              <div key={wf.id} className="grid gap-2 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{wf.name}</span>
                    {wf.isSystem && <Badge variant="secondary">Built-in</Badge>}
                    {wf.isDefault && <Badge variant="info">Default</Badge>}
                    {wf.appliesToTicketType && <Badge variant="outline">{wf.appliesToTicketType} only</Badge>}
                    {!wf.isActive && <Badge variant="outline">Inactive</Badge>}
                  </div>
                  {!readOnly && entitled && (
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" disabled={duplicate.isPending} onClick={() => duplicate.mutate(wf)}>
                        Duplicate
                      </Button>
                      {!wf.isSystem && (
                        <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(wf.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {wf.statuses
                    .slice()
                    .sort((a, b) => a.order - b.order)
                    .map((s) => (
                      <Tooltip key={s.id}>
                        <TooltipTrigger asChild>
                          <Badge variant={CATEGORY_VARIANT[s.category]}>{s.name}</Badge>
                        </TooltipTrigger>
                        <TooltipContent>
                          <span className="text-xs">
                            Category {s.category} · reports as <span className="font-mono">{s.legacyStatus}</span>
                          </span>
                        </TooltipContent>
                      </Tooltip>
                    ))}
                </div>

                <p className="text-xs text-muted-foreground">
                  {wf.transitions.length} transition{wf.transitions.length === 1 ? "" : "s"}
                  {wf.isSystem && " — matches the six statuses this app has always enforced."}
                </p>
              </div>
            ))}
          </div>
        )}

        {entitled && !readOnly && (
          <p className="text-xs text-muted-foreground">
            Start from <span className="font-medium">Duplicate</span> on the Default workflow — a copy already has a
            valid status graph, so you only have to rename and add, never rebuild it from nothing.
            {meta.data && <> Categories available: {meta.data.categories.join(", ")}.</>}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
