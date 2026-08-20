/**
 * WHAT: one change request, in full — the twelve sections of the request form (spec §9), its
 * approval, its lifecycle, and the tickets and people tagged on it.
 *
 * WHY TABS AND NOT A WIZARD: a change is drafted over days, edited by two or three people, and read
 * far more often than it is written. A stepper is right for a form you fill once and never revisit;
 * it is wrong for a record. Tabs let somebody jump straight to the rollback plan a year later, and
 * the "still needed" checklist in the header does the job a progress bar would — it names what is
 * missing rather than implying a percentage.
 *
 * WHY EVERY FIELD SAVES ON BLUR: the alternative is a Save button per section and a page that can be
 * left half-committed. Blur-saving means the draft on the server always matches what is on screen,
 * which is what makes it safe for two people to be in the same change.
 *
 * WHAT IS DELIBERATELY NOT HERE: comments, attachments and the activity trail. They live on the
 * underlying ticket and already have a home in the ticket sheet, which the header links to. Second
 * copies are how two surfaces start disagreeing about the same conversation.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { changeBands, changeKinds, changeOutcomes, changeStateTransitions, permissions, type ChangeBand, type ChangeState } from "@timesheet/shared";
import { AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink, Loader2, Plus, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { Fragment, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  CHANGE_ACTION_LABEL,
  CHANGE_KIND_TONE,
  CHANGE_OUTCOME_TONE,
  CHANGE_RISK_TONE,
  CHANGE_STATE_TONE,
  humanizeChange,
  CHANGE_KIND_MEANING,
  CHANGE_TAB_GROUPS,
  tabForRequirement
} from "../lib/change-visuals";
import { cn } from "../lib/utils";
import { changeApi, userApi, type ChangeDetail as ChangeDetailRow } from "../services/api";
import { useAuthStore } from "../store/auth";
import { Badge } from "../components/ui/badge";
import { BorderGlow } from "../components/ui/border-glow";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { RichTextEditor } from "../components/ui/rich-text-editor";
import { SearchableSelect } from "../components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { ChangeRunbook, ChangeSlaLadder } from "../components/change/ChangeRunbook";
import { ChangeContextTab } from "../components/change/ChangeContextTab";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

const ENVIRONMENTS = ["DEVELOPMENT", "QA", "UAT", "STAGING", "PRODUCTION", "DR"] as const;

function toLocalInput(iso: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 16) : "";
}

/* ------------------------------------------------------------------ *
 * Field primitives — one save path, so no section can invent its own
 * ------------------------------------------------------------------ */

interface FieldProps {
  label: string;
  hint?: string;
  disabled?: boolean;
  required?: boolean;
}

function FieldShell({ label, hint, required, children }: FieldProps & { children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-sm">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </Label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}

function TextField({
  value,
  onSave,
  multiline,
  placeholder,
  type = "text",
  ...shell
}: FieldProps & {
  value: string | number | null;
  onSave: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
  type?: string;
}) {
  return (
    <FieldShell {...shell}>
      {multiline ? (
        <Textarea
          rows={3}
          defaultValue={value ?? ""}
          disabled={shell.disabled}
          placeholder={placeholder}
          onBlur={(e) => e.target.value !== String(value ?? "") && onSave(e.target.value)}
        />
      ) : (
        <Input
          type={type}
          defaultValue={value ?? ""}
          disabled={shell.disabled}
          placeholder={placeholder}
          onBlur={(e) => e.target.value !== String(value ?? "") && onSave(e.target.value)}
        />
      )}
    </FieldShell>
  );
}

/** Rich text saves on an explicit press, not on blur: the editor blurs when you click its own
 *  toolbar, and an autosave per bold-button would be a request per keystroke-ish. */
function RichField({ value, onSave, ...shell }: FieldProps & { value: string | null; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value ?? "");
  const dirty = draft !== (value ?? "");
  return (
    <FieldShell {...shell}>
      <RichTextEditor value={draft} onChange={setDraft} ariaLabel={shell.label} minHeight="min-h-24" />
      {dirty && !shell.disabled && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => onSave(draft)}>
            Save
          </Button>
        </div>
      )}
    </FieldShell>
  );
}

function BoolField({ value, onSave, ...shell }: FieldProps & { value: boolean; onSave: (v: boolean) => void }) {
  return (
    <label className="flex items-start justify-between gap-3 rounded-md border border-border p-2.5">
      <span className="grid gap-0.5">
        <span className="text-sm font-medium">{shell.label}</span>
        {shell.hint && <span className="text-xs text-muted-foreground">{shell.hint}</span>}
      </span>
      <Switch checked={value} disabled={shell.disabled} onCheckedChange={onSave} />
    </label>
  );
}

function PickField({
  value,
  options,
  onSave,
  placeholder,
  ...shell
}: FieldProps & {
  value: string | null;
  /** `hint` is rendered under the option's name in the open dropdown. Used where the choice carries
   *  consequences the word alone does not convey — see CHANGE_KIND_MEANING. */
  options: Array<{ id: string; name: string; hint?: string }>;
  onSave: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <FieldShell {...shell}>
      <Select value={value ?? ""} disabled={shell.disabled} onValueChange={onSave}>
        <SelectTrigger>
          {/* The NAME only. Radix mirrors the selected item's content into the trigger, so an option
              carrying a hint would render both lines inside the collapsed control and overflow into
              the field below it. Undefined children fall back to the placeholder, as intended. */}
          <SelectValue placeholder={placeholder ?? "Not set"}>{options.find((o) => o.id === value)?.name}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.hint ? (
                <span className="grid gap-0.5 py-0.5">
                  <span>{o.name}</span>
                  <span className="text-xs text-muted-foreground">{o.hint}</span>
                </span>
              ) : (
                o.name
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldShell>
  );
}

/** A JSON string[] column, edited as comma-separated text. Honest about what it is: a list of names
 *  somebody typed, not a foreign key into a catalogue that does not exist yet. */
function ListField({ value, onSave, ...shell }: FieldProps & { value: string[]; onSave: (v: string[]) => void }) {
  return (
    <TextField
      {...shell}
      value={(value ?? []).join(", ")}
      placeholder="Comma separated"
      onSave={(v) => onSave(v.split(",").map((s) => s.trim()).filter(Boolean))}
    />
  );
}

const band = (v: string) => ({ id: v, name: humanizeChange(v) });

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export function ChangeDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const detail = useQuery({ queryKey: ["change", id], queryFn: () => changeApi.get(id), enabled: Boolean(id) });
  const master = useQuery({ queryKey: ["changes", "master-data"], queryFn: changeApi.masterData });
  const change = detail.data;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["change", id] });
    queryClient.invalidateQueries({ queryKey: ["changes"] });
  };

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) => changeApi.update(id, payload),
    onSuccess: () => invalidate(),
    onError: (err: any) => toast.error("Could not save", { description: serverMessage(err, "Try again.") })
  });

  const move = useMutation({
    mutationFn: (to: ChangeState) => changeApi.transition(id, to),
    onSuccess: (updated) => {
      toast.success(`Moved to ${humanizeChange(updated.state).toLowerCase()}`);
      invalidate();
    },
    // The 422 names every missing field at once — surfacing it verbatim is the point.
    onError: (err: any) => toast.error("Cannot move this change yet", { description: serverMessage(err, "Try again.") })
  });

  if (detail.isLoading) return <Skeleton className="h-96 w-full" />;
  if (!change) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          That change does not exist, or it is in a project you cannot see.
        </CardContent>
      </Card>
    );
  }

  const ro = !change.canEdit;
  const set = (patch: Record<string, unknown>) => save.mutate(patch);
  const legalMoves = (changeStateTransitions[change.state] ?? []) as ChangeState[];
  const md = master.data;

  // Which tabs still owe something, mapped from the server's own list of missing requirements so
  // the two can never disagree about what is outstanding.
  const outstandingTabs = new Set(
    (change.blockingForSubmit ?? []).map(tabForRequirement).filter((t): t is string => Boolean(t))
  );

  return (
    <div className="grid gap-4">
      <ChangeHeader change={change} onBack={() => navigate("/app/changes")} />

      {change.blockingForSubmit.length > 0 && change.state === "DRAFT" && (
        <div className="rounded-lg border border-warning/40 bg-warning/5 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-warning">
            <AlertTriangle className="h-3.5 w-3.5" />
            Before this can be submitted
          </p>
          <ul className="mt-1.5 grid gap-0.5 text-sm text-muted-foreground">
            {change.blockingForSubmit.map((f) => (
              <li key={f}>· {f}</li>
            ))}
          </ul>
          {/* Offered exactly where the gap is named. It drafts only the sections still EMPTY, and
              nothing reaches the change until each row is accepted on the AI suggestions page — the
              backout plan is the most consequential field here, so a person stays in between. */}
          <DraftAssistButton changeId={change.id} />
        </div>
      )}

      {/* Stated here rather than only on the Runbook tab: this is why the Implement button will
          refuse, and somebody looking for that button needs the reason before they hunt for it. */}
      {(change.blockingDependencies?.length ?? 0) > 0 && change.state !== "CLOSED" && (
        <div className="rounded-lg border border-warning/40 bg-warning/5 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-warning">
            <AlertTriangle className="h-3.5 w-3.5" />
            Waiting on {change.blockingDependencies.length} {change.blockingDependencies.length === 1 ? "dependency" : "dependencies"}
          </p>
          <ul className="mt-1.5 grid gap-0.5 text-sm text-muted-foreground">
            {change.blockingDependencies.map((d) => (
              <li key={d.id}>· {d.description}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <ApprovalCard change={change} onDecided={invalidate} />
        {change.sla && (
          <Card>
            <CardContent className="p-3 sm:p-4">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Against the clock</h3>
              <ChangeSlaLadder sla={change.sla} />
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardContent className="p-3 sm:p-4">
          <Tabs defaultValue="basics">
            {/* Scrolls rather than wraps: thirteen tabs on a laptop is a two-line strip that pushes
                the form down every time, and a strip that moves is one people lose their place in.
                Grouped into Define / Plan / Deliver so it reads as a sequence rather than a list of
                thirteen equal things, and each tab holding an outstanding requirement carries a dot —
                naming what is missing without saying where it lives is most of the way to not saying
                it at all. */}
            <TabsList className="mb-4 flex w-full flex-nowrap items-center gap-0.5 overflow-x-auto">
              {CHANGE_TAB_GROUPS.map((group, groupIndex) => (
                <Fragment key={group.label}>
                  {groupIndex > 0 && <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />}
                  <span className="shrink-0 select-none px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </span>
                  {group.tabs.map((tab) => (
                    <TabsTrigger key={tab.value} value={tab.value} className="shrink-0">
                      {tab.label}
                      {outstandingTabs.has(tab.value) && (
                        <span
                          className="ml-1.5 h-1.5 w-1.5 rounded-full bg-warning"
                          title="Something on this tab is still needed before this change can be submitted"
                        />
                      )}
                    </TabsTrigger>
                  ))}
                </Fragment>
              ))}
            </TabsList>

            <TabsContent value="basics">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField label="Title" required disabled={ro} value={change.ticket.title} onSave={(v) => set({ title: v })} />
                <PickField
                  label="Type"
                  required
                  disabled={ro}
                  value={change.changeKind}
                  options={changeKinds.map((k) => ({ ...band(k), hint: CHANGE_KIND_MEANING[k] }))}
                  onSave={(v) => set({ changeKind: v })}
                  hint="Each type carries different obligations — see the options."
                />
                <PickField
                  label="Category"
                  disabled={ro}
                  value={change.categoryId}
                  options={(md?.categories ?? []).map((c) => ({ id: c.id, name: c.name }))}
                  onSave={(v) => set({ categoryId: v })}
                />
                <PickField
                  label="Source"
                  disabled={ro}
                  value={change.sourceId}
                  options={(md?.sources ?? []).map((c) => ({ id: c.id, name: c.name }))}
                  onSave={(v) => set({ sourceId: v })}
                  hint="What prompted it — an incident, a project, routine maintenance."
                />
                <PickField
                  label="Environment"
                  required
                  disabled={ro}
                  value={change.environment}
                  options={ENVIRONMENTS.map(band)}
                  onSave={(v) => set({ environment: v })}
                />
                <PickField
                  label="Application"
                  disabled={ro}
                  value={change.applicationId}
                  options={(md?.applications ?? []).map((a) => ({ id: a.id, name: a.name }))}
                  onSave={(v) => set({ applicationId: v })}
                />
                <TextField label="Business unit" disabled={ro} value={change.businessUnit} onSave={(v) => set({ businessUnit: v })} />
                <TextField label="Department" disabled={ro} value={change.department} onSave={(v) => set({ department: v })} />
                <TextField label="Service" disabled={ro} value={change.serviceName} onSave={(v) => set({ serviceName: v })} />
                <TextField label="Product" disabled={ro} value={change.productName} onSave={(v) => set({ productName: v })} />
                <PeoplePicker label="Business owner" disabled={ro} value={change.businessOwnerId} onSave={(v) => set({ businessOwnerId: v || null })} />
                <PeoplePicker label="Technical owner" disabled={ro} value={change.technicalOwnerId} onSave={(v) => set({ technicalOwnerId: v || null })} />
              </div>
            </TabsContent>

            <TabsContent value="business">
              <div className="grid gap-4">
                <RichField
                  label="Justification"
                  required
                  hint="Why now, and what happens if it does not go ahead. The first thing an approver reads."
                  disabled={ro}
                  value={change.justification}
                  onSave={(v) => set({ justification: v })}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField label="Problem statement" multiline disabled={ro} value={change.problemStatement} onSave={(v) => set({ problemStatement: v })} />
                  <TextField label="Current situation" multiline disabled={ro} value={change.currentSituation} onSave={(v) => set({ currentSituation: v })} />
                  <TextField label="Reason for change" multiline disabled={ro} value={change.reasonForChange} onSave={(v) => set({ reasonForChange: v })} />
                  <TextField label="Expected outcome" multiline disabled={ro} value={change.expectedOutcome} onSave={(v) => set({ expectedOutcome: v })} />
                  <TextField label="Business benefits" multiline disabled={ro} value={change.businessBenefits} onSave={(v) => set({ businessBenefits: v })} />
                  <TextField label="Cost of not implementing" multiline disabled={ro} value={change.costOfNotImplementing} onSave={(v) => set({ costOfNotImplementing: v })} />
                  <TextField label="Revenue impact" disabled={ro} value={change.revenueImpact} onSave={(v) => set({ revenueImpact: v })} />
                  <TextField label="Project reference" disabled={ro} value={change.projectReference} onSave={(v) => set({ projectReference: v })} />
                  <TextField label="Compliance reference" disabled={ro} value={change.complianceReference} onSave={(v) => set({ complianceReference: v })} />
                  <BoolField label="Regulatory requirement" disabled={ro} value={change.regulatoryRequirement} onSave={(v) => set({ regulatoryRequirement: v })} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="impact">
              <div className="grid gap-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {(
                    [
                      ["productionAffected", "Production affected"],
                      ["customerAffected", "Customer affected"],
                      ["serviceInterruption", "Service interruption"],
                      ["dataModified", "Data modified"],
                      ["dataMigration", "Data migration"],
                      ["appRestartRequired", "Application restart"],
                      ["serverRestartRequired", "Server restart"],
                      ["dbRestartRequired", "Database restart"],
                      ["securityImpact", "Security impact"],
                      ["complianceImpact", "Compliance impact"],
                      ["slaImpact", "SLA impact"],
                      ["externalIntegrationImpact", "External integration impact"]
                    ] as const
                  ).map(([key, label]) => (
                    <BoolField key={key} label={label} disabled={ro} value={Boolean((change as never as Record<string, boolean>)[key])} onSave={(v) => set({ [key]: v })} />
                  ))}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <BoolField label="Requires downtime" disabled={ro} value={change.requiresDowntime} onSave={(v) => set({ requiresDowntime: v })} />
                  {change.requiresDowntime && (
                    <TextField
                      label="Expected downtime (minutes)"
                      required
                      type="number"
                      disabled={ro}
                      value={change.downtimeMinutes}
                      onSave={(v) => set({ downtimeMinutes: v ? Number(v) : null })}
                    />
                  )}
                  <TextField label="Affected users" type="number" disabled={ro} value={change.affectedUserCount} onSave={(v) => set({ affectedUserCount: v ? Number(v) : null })} />
                  <BoolField label="Customer notification required" disabled={ro} value={change.customerNotificationRequired} onSave={(v) => set({ customerNotificationRequired: v })} />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <ListField label="Affected services" disabled={ro} value={change.affectedServices} onSave={(v) => set({ affectedServices: v })} />
                  <ListField label="Affected applications" disabled={ro} value={change.affectedApplications} onSave={(v) => set({ affectedApplications: v })} />
                  <ListField label="Affected customers" disabled={ro} value={change.affectedCustomers} onSave={(v) => set({ affectedCustomers: v })} />
                  <ListField label="Affected locations" disabled={ro} value={change.affectedLocations} onSave={(v) => set({ affectedLocations: v })} />
                  <ListField label="Affected departments" disabled={ro} value={change.affectedDepartments} onSave={(v) => set({ affectedDepartments: v })} />
                  <ListField label="Affected infrastructure" disabled={ro} value={change.affectedInfrastructure} onSave={(v) => set({ affectedInfrastructure: v })} />
                  <ListField label="Affected APIs" disabled={ro} value={change.affectedApis} onSave={(v) => set({ affectedApis: v })} />
                  <ListField label="Affected databases" disabled={ro} value={change.affectedDatabases} onSave={(v) => set({ affectedDatabases: v })} />
                  <ListField label="Affected integrations" disabled={ro} value={change.affectedIntegrations} onSave={(v) => set({ affectedIntegrations: v })} />
                  <ListField label="Compliance tags" hint="SOX, ISO 27001, GDPR, PCI" disabled={ro} value={change.complianceTags} onSave={(v) => set({ complianceTags: v })} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="risk">
              <RiskSection change={change} parameters={md?.riskParameters ?? []} disabled={ro} onSave={set} />
            </TabsContent>

            <TabsContent value="implementation">
              <div className="grid gap-4">
                <RichField label="Implementation plan" required disabled={ro} value={change.implementationPlan} onSave={(v) => set({ implementationPlan: v })} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField label="Summary" multiline disabled={ro} value={change.implementationSummary} onSave={(v) => set({ implementationSummary: v })} />
                  <TextField label="Objective" multiline disabled={ro} value={change.implementationObjective} onSave={(v) => set({ implementationObjective: v })} />
                  <TextField label="Pre-requisites" multiline disabled={ro} value={change.prerequisites} onSave={(v) => set({ prerequisites: v })} />
                  <TextField label="Required access" multiline disabled={ro} value={change.requiredAccess} onSave={(v) => set({ requiredAccess: v })} />
                  <TextField label="Required tools" multiline disabled={ro} value={change.requiredTools} onSave={(v) => set({ requiredTools: v })} />
                  <TextField label="Required resources" multiline disabled={ro} value={change.requiredResources} onSave={(v) => set({ requiredResources: v })} />
                  <PeoplePicker label="Primary engineer" disabled={ro} value={change.primaryEngineerId} onSave={(v) => set({ primaryEngineerId: v || null })} />
                  <PeoplePicker label="Backup engineer" disabled={ro} value={change.backupEngineerId} onSave={(v) => set({ backupEngineerId: v || null })} />
                  <TextField label="Expected duration (minutes)" type="number" disabled={ro} value={change.expectedDurationMinutes} onSave={(v) => set({ expectedDurationMinutes: v ? Number(v) : null })} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="testing">
              <div className="grid gap-4">
                <RichField
                  label="Test plan"
                  hint={change.riskLevel !== "LOW" ? "Required above low risk." : undefined}
                  disabled={ro}
                  value={change.testPlan}
                  onSave={(v) => set({ testPlan: v })}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <PickField label="Test environment" disabled={ro} value={change.testEnvironment} options={ENVIRONMENTS.map(band)} onSave={(v) => set({ testEnvironment: v })} />
                  <TextField label="Testing team" disabled={ro} value={change.testingTeam} onSave={(v) => set({ testingTeam: v })} />
                  <TextField label="Testing starts" type="datetime-local" disabled={ro} value={toLocalInput(change.testingStart)} onSave={(v) => set({ testingStart: v ? new Date(v).toISOString() : null })} />
                  <TextField label="Testing ends" type="datetime-local" disabled={ro} value={toLocalInput(change.testingEnd)} onSave={(v) => set({ testingEnd: v ? new Date(v).toISOString() : null })} />
                  <BoolField label="UAT required" disabled={ro} value={change.uatRequired} onSave={(v) => set({ uatRequired: v })} />
                  <BoolField label="Business validation required" disabled={ro} value={change.businessValidationRequired} onSave={(v) => set({ businessValidationRequired: v })} />
                </div>
                <TextField label="Validation criteria" multiline disabled={ro} value={change.validationCriteria} onSave={(v) => set({ validationCriteria: v })} />
              </div>
            </TabsContent>

            <TabsContent value="rollback">
              <div className="grid gap-4">
                <RichField
                  label="Backout plan"
                  required={change.riskLevel === "HIGH" || change.changeKind === "MAJOR" || change.dataMigration}
                  hint={
                    change.riskLevel === "HIGH" || change.changeKind === "MAJOR" || change.dataMigration
                      ? "Required — this change is high risk, major, or moves data."
                      : "Optional at this risk level, and still the field people wish they had written."
                  }
                  disabled={ro}
                  value={change.backoutPlan}
                  onSave={(v) => set({ backoutPlan: v })}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <BoolField label="Rollback required" disabled={ro} value={change.rollbackRequired} onSave={(v) => set({ rollbackRequired: v })} />
                  <BoolField label="Backup required" disabled={ro} value={change.backupRequired} onSave={(v) => set({ backupRequired: v })} />
                  <TextField label="Rollback criteria" multiline disabled={ro} value={change.rollbackCriteria} onSave={(v) => set({ rollbackCriteria: v })} />
                  <TextField label="Rollback procedure" multiline disabled={ro} value={change.rollbackProcedure} onSave={(v) => set({ rollbackProcedure: v })} />
                  <PeoplePicker label="Rollback owner" disabled={ro} value={change.rollbackOwnerId} onSave={(v) => set({ rollbackOwnerId: v || null })} />
                  <TextField label="Estimated rollback (minutes)" type="number" disabled={ro} value={change.estimatedRollbackMinutes} onSave={(v) => set({ estimatedRollbackMinutes: v ? Number(v) : null })} />
                  <TextField label="Backup location" disabled={ro} value={change.backupLocation} onSave={(v) => set({ backupLocation: v })} />
                  <BoolField label="Backup verified" disabled={ro} value={change.backupVerified} onSave={(v) => set({ backupVerified: v })} />
                </div>
                <TextField label="Restore procedure" multiline disabled={ro} value={change.restoreProcedure} onSave={(v) => set({ restoreProcedure: v })} />
              </div>
            </TabsContent>

            <TabsContent value="release">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField label="Release version" disabled={ro} value={change.releaseVersion} onSave={(v) => set({ releaseVersion: v })} />
                <TextField label="Build number" disabled={ro} value={change.buildNumber} onSave={(v) => set({ buildNumber: v })} />
                <TextField label="Repository" disabled={ro} value={change.repository} onSave={(v) => set({ repository: v })} />
                <TextField label="Branch" disabled={ro} value={change.branch} onSave={(v) => set({ branch: v })} />
                <TextField label="Deployment package" disabled={ro} value={change.deploymentPackage} onSave={(v) => set({ deploymentPackage: v })} />
                <TextField label="CI/CD pipeline" disabled={ro} value={change.cicdPipeline} onSave={(v) => set({ cicdPipeline: v })} />
                <TextField label="Deployment tool" disabled={ro} value={change.deploymentTool} onSave={(v) => set({ deploymentTool: v })} />
                <TextField label="Deployment method" disabled={ro} value={change.deploymentMethod} onSave={(v) => set({ deploymentMethod: v })} />
                <TextField label="Release ticket" disabled={ro} value={change.releaseTicket} onSave={(v) => set({ releaseTicket: v })} />
                <div className="grid gap-3 sm:col-span-2 sm:grid-cols-4">
                  <BoolField label="Configuration changes" disabled={ro} value={change.configurationChanges} onSave={(v) => set({ configurationChanges: v })} />
                  <BoolField label="Database changes" disabled={ro} value={change.databaseChanges} onSave={(v) => set({ databaseChanges: v })} />
                  <BoolField label="API changes" disabled={ro} value={change.apiChanges} onSave={(v) => set({ apiChanges: v })} />
                  <BoolField label="Infrastructure changes" disabled={ro} value={change.infrastructureChanges} onSave={(v) => set({ infrastructureChanges: v })} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="schedule">
              <ScheduleSection change={change} disabled={ro} onSave={set} />
            </TabsContent>

            <TabsContent value="comms">
              <div className="grid gap-4">
                <RichField
                  label="Communication plan"
                  hint={change.requiresDowntime ? "Required — this change takes something down. Who gets told, and when?" : undefined}
                  disabled={ro}
                  value={change.communicationPlan}
                  onSave={(v) => set({ communicationPlan: v })}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <BoolField label="Internal communication required" disabled={ro} value={change.internalCommRequired} onSave={(v) => set({ internalCommRequired: v })} />
                  <BoolField label="Stakeholder notification required" disabled={ro} value={change.stakeholderNotifyRequired} onSave={(v) => set({ stakeholderNotifyRequired: v })} />
                  <TextField label="Channel" hint="Email, SMS, Teams, portal, service desk" disabled={ro} value={change.communicationChannel} onSave={(v) => set({ communicationChannel: v })} />
                  <PeoplePicker label="Communication owner" disabled={ro} value={change.communicationOwnerId} onSave={(v) => set({ communicationOwnerId: v || null })} />
                  <TextField label="Notification date" type="datetime-local" disabled={ro} value={toLocalInput(change.notificationDate)} onSave={(v) => set({ notificationDate: v ? new Date(v).toISOString() : null })} />
                </div>
                <TextField label="Notification audience" multiline disabled={ro} value={change.notificationAudience} onSave={(v) => set({ notificationAudience: v })} />
              </div>
            </TabsContent>

            <TabsContent value="context">
              <ChangeContextTab changeId={change.id} />
            </TabsContent>

            <TabsContent value="runbook">
              <ChangeRunbook
                changeId={change.id}
                steps={change.implementationSteps ?? []}
                tests={change.testCases ?? []}
                dependencies={change.dependencies ?? []}
                /* Deliberately NOT gated on the post-approval freeze: recording that a step failed is
                   the work that happens after approval. The API applies the same rule. */
                disabled={!change.canEdit}
              />
            </TabsContent>

            <TabsContent value="tagging">
              <TaggingSection change={change} disabled={ro} onChanged={invalidate} />
            </TabsContent>

            <TabsContent value="outcome">
              <div className="grid gap-4">
                <PickField
                  label="Outcome"
                  disabled={change.state === "CLOSED"}
                  value={change.outcome}
                  options={changeOutcomes.map(band)}
                  onSave={(v) => set({ outcome: v })}
                  hint="Recording what happened stays possible after approval — amending the plan does not."
                />
                <RichField
                  label="Post-implementation review"
                  hint={change.outcome !== "SUCCESSFUL" ? "Required to close — this change did not go cleanly, or is major." : "Optional for a clean routine change."}
                  disabled={change.state === "CLOSED"}
                  value={change.pirNotes}
                  onSave={(v) => set({ pirNotes: v })}
                />
                {/* Offered only while the field is empty and the change has actually run. It drafts
                    from what was recorded — failed steps, failed tests, the outcome — and writes
                    nothing: a review nobody stood behind is worse than no review, because it looks
                    like one. */}
                {!change.pirNotes && change.state !== "CLOSED" && <PirAssistButton changeId={change.id} />}
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField label="Actual result" multiline disabled={change.state === "CLOSED"} value={change.actualResult} onSave={(v) => set({ actualResult: v })} />
                  <TextField label="Issues encountered" multiline disabled={change.state === "CLOSED"} value={change.issuesEncountered} onSave={(v) => set({ issuesEncountered: v })} />
                  <TextField label="Lessons learned" multiline disabled={change.state === "CLOSED"} value={change.lessonsLearned} onSave={(v) => set({ lessonsLearned: v })} />
                  <TextField label="Recommendations" multiline disabled={change.state === "CLOSED"} value={change.recommendations} onSave={(v) => set({ recommendations: v })} />
                  <TextField label="Follow-up actions" multiline disabled={change.state === "CLOSED"} value={change.followUpActions} onSave={(v) => set({ followUpActions: v })} />
                  <PeoplePicker label="Follow-up owner" disabled={change.state === "CLOSED"} value={change.followUpOwnerId} onSave={(v) => set({ followUpOwnerId: v || null })} />
                  <TextField label="Actual downtime (minutes)" type="number" disabled={change.state === "CLOSED"} value={change.actualDowntimeMinutes} onSave={(v) => set({ actualDowntimeMinutes: v ? Number(v) : null })} />
                  <TextField label="Incident reference" disabled={change.state === "CLOSED"} value={change.incidentReference} onSave={(v) => set({ incidentReference: v })} />
                  <BoolField label="Incident created" disabled={change.state === "CLOSED"} value={change.incidentCreated} onSave={(v) => set({ incidentCreated: v })} />
                  <BoolField label="Documentation updated" disabled={change.state === "CLOSED"} value={change.documentationUpdated} onSave={(v) => set({ documentationUpdated: v })} />
                  <BoolField label="Monitoring completed" disabled={change.state === "CLOSED"} value={change.monitoringCompleted} onSave={(v) => set({ monitoringCompleted: v })} />
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {legalMoves.length > 0 && (
        <Card>
          <CardContent className="grid gap-2 p-3 sm:p-4">
            <Label className="text-xs uppercase text-muted-foreground">Move this change</Label>
            <div className="flex flex-wrap gap-2">
              {legalMoves.map((to) => (
                <Button
                  key={to}
                  size="sm"
                  variant={to === "CANCELLED" || to === "DRAFT" ? "outline" : "default"}
                  disabled={move.isPending || !user?.permissions.includes(permissions.CHANGES_WRITE)}
                  onClick={() => move.mutate(to)}
                >
                  {move.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {CHANGE_ACTION_LABEL[to] ?? humanizeChange(to)}
                </Button>
              ))}
            </div>
            {change.state === "AWAITING_APPROVAL" && (
              <p className="text-xs text-muted-foreground">
                Approved and rejected are written only by a recorded decision — that is what the approval is for.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Header, approval, and the sections with their own behaviour
 * ------------------------------------------------------------------ */

/**
 * Asks the model to draft the sections this change still owes.
 *
 * It writes NOTHING. The reply is a proposal id, and each drafted section is a row somebody accepts
 * or rejects — so the button's success state points at that queue rather than claiming the change
 * has been filled in. A draft nobody wrote is worse than a blank field, because a blank field is
 * honest about not having been thought about.
 */
function DraftAssistButton({ changeId }: { changeId: string }) {
  const [busy, setBusy] = useState(false);
  const [proposalId, setProposalId] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      const result = await changeApi.draftAssist(changeId);
      if (!result.proposalId) {
        toast.info("Nothing to draft", { description: result.message ?? "Every section already has something in it." });
        return;
      }
      setProposalId(result.proposalId);
      toast.success(`Drafted ${result.drafted.length} section${result.drafted.length === 1 ? "" : "s"}`, {
        description: "Nothing has been written yet — accept the ones you want."
      });
    } catch (err: any) {
      // Usually "AI is off for this workspace", which the server says plainly. Surfaced rather than
      // swallowed: "nothing happened" is the worst possible answer to a button.
      toast.error("Could not draft", { description: serverMessage(err, "Try again.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2">
      <Button variant="ai" size="sm" disabled={busy} onClick={() => void run()}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        Draft the missing sections
      </Button>
      {proposalId && (
        <Link to="/app/proposals" className="text-xs font-medium text-primary hover:underline">
          Review and accept them →
        </Link>
      )}
    </div>
  );
}

function ChangeHeader({ change, onBack }: { change: ChangeDetailRow; onBack: () => void }) {
  return (
    <div className="grid gap-2">
      <button type="button" onClick={onBack} className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" />
        All changes
      </button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-muted-foreground">{change.changeKey}</p>
          <h1 className="text-2xl font-black tracking-tight">{change.ticket.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {change.ticket.project.name} · raised by {change.ticket.reporter.name}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={CHANGE_STATE_TONE[change.state]}>{humanizeChange(change.state)}</Badge>
          <Badge variant={CHANGE_KIND_TONE[change.changeKind]}>{humanizeChange(change.changeKind)}</Badge>
          <Badge variant={CHANGE_RISK_TONE[change.riskLevel]}>
            {humanizeChange(change.riskLevel)} · {change.riskScore}/100
          </Badge>
          {change.outcome && <Badge variant={CHANGE_OUTCOME_TONE[change.outcome]}>{humanizeChange(change.outcome)}</Badge>}
          <Link to={`/app/tickets?open=${change.ticketId}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
            Comments &amp; files <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </div>

      {/* The four facts somebody checks before opening a single tab: where it lands, when, who runs
          it, and what kind of thing it is. Each lives in a tab as well — this is a reading surface,
          not a second place to edit them. */}
      <dl className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <HeaderFact label="Environment" value={humanizeChange(change.environment)} />
        <HeaderFact label="Window" value={formatWindow(change.plannedStart, change.plannedEnd)} />
        <HeaderFact label="Implementer" value={change.ticket.assignee?.name ?? "Unassigned"} />
        <HeaderFact label="Category" value={change.category?.name ?? "None"} />
      </dl>
    </div>
  );
}

function HeaderFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}

/** "not scheduled" rather than an empty cell — the absence is the useful fact when a change is
 *  waiting on a window. */
function formatWindow(start: string | null, end: string | null): string {
  if (!start) return "Not scheduled";
  const from = new Date(start);
  const to = end ? new Date(end) : null;
  const day = from.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return to ? `${day} ${time(from)}–${time(to)}` : `${day} ${time(from)}`;
}

const DECISION_TONE: Record<string, "success" | "destructive" | "muted"> = {
  APPROVED: "success",
  REJECTED: "destructive",
  PENDING: "muted",
  CANCELLED: "muted",
  RETURNED: "muted"
};

function ApprovalCard({ change, onDecided }: { change: ChangeDetailRow; onDecided: () => void }) {
  const [comments, setComments] = useState("");
  const decide = useMutation({
    mutationFn: (approved: boolean) => changeApi.decide(change.id, approved ? "APPROVED" : "REJECTED", comments || undefined),
    onSuccess: () => {
      toast.success("Decision recorded");
      setComments("");
      onDecided();
    },
    onError: (err: any) => toast.error("Could not record that", { description: serverMessage(err, "Try again.") })
  });

  if (change.approvals.length === 0) return null;
  const rounds = [...new Set(change.approvals.map((a) => a.round))].sort((a, b) => b - a);

  return (
    <Card>
      <CardContent className="grid gap-3 p-3 sm:p-4">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs uppercase text-muted-foreground">Approval</Label>
          {rounds.length > 1 && <span className="text-[11px] text-muted-foreground">Round {rounds[0]} of {rounds.length}</span>}
        </div>

        {rounds.map((round) => (
          <ul key={round} className={cn("grid gap-1.5", round !== rounds[0] && "opacity-60")}>
            {round !== rounds[0] && <li className="text-[11px] uppercase tracking-wide text-muted-foreground">Round {round}</li>}
            {change.approvals
              .filter((a) => a.round === round)
              .map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate">
                    {a.approver?.name ?? "Unknown"}
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {a.reason === "MANAGER_OF_REQUESTER" ? "manager" : "super admin"}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {a.comments && <span className="max-w-[320px] truncate text-xs text-muted-foreground">“{a.comments}”</span>}
                    <Badge variant={DECISION_TONE[a.status] ?? "muted"}>{humanizeChange(a.status)}</Badge>
                  </span>
                </li>
              ))}
          </ul>
        ))}

        {/* Role-based, and decided server-side: `canDecide` is true only for the named approver or a
            super admin, so these buttons cannot appear for somebody the API would refuse. */}
        {change.canDecide && (
          <div className="grid gap-2 border-t border-border pt-3">
            <Textarea rows={2} value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Comments — carried into the decision email." />
            <div className="flex gap-2">
              <Button size="sm" variant="success" disabled={decide.isPending} onClick={() => decide.mutate(true)}>
                <ShieldCheck className="h-3.5 w-3.5" />
                Approve
              </Button>
              <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate(false)}>
                Reject
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PeoplePicker({ value, onSave, ...shell }: FieldProps & { value: string | null; onSave: (v: string) => void }) {
  const users = useQuery({ queryKey: ["users", "pickable"], queryFn: () => userApi.list() });
  return (
    <FieldShell {...shell}>
      <SearchableSelect
        aria-label={shell.label}
        options={(users.data ?? []).map((u: any) => ({ id: u.id, name: u.name }))}
        value={value ?? ""}
        onChange={onSave}
        disabled={shell.disabled}
        placeholder="Not set"
        searchPlaceholder="Search people…"
        emptyText="No one matches."
        clearable
        clearLabel="Not set"
      />
    </FieldShell>
  );
}

/** The risk matrix, as the questions that feed it. The score is read-only everywhere — it is derived
 *  server-side so two changes with the same answers cannot carry different risk. */
function RiskSection({
  change,
  parameters,
  disabled,
  onSave
}: {
  change: ChangeDetailRow;
  parameters: Array<{ id: string; key: string; label: string; weight: number }>;
  disabled: boolean;
  onSave: (p: Record<string, unknown>) => void;
}) {
  const inputs = (change.riskInputs ?? {}) as Record<string, ChangeBand>;
  const unanswered = parameters.filter((p) => !inputs[p.key]).length;
  const [narrative, setNarrative] = useState<string | null>(null);
  const [narrating, setNarrating] = useState(false);

  const explain = async () => {
    setNarrating(true);
    try {
      const result = await changeApi.riskNarrative(change.id);
      setNarrative(result.narrative ?? "The model returned nothing to show.");
    } catch (err: any) {
      // The usual failure is that AI is switched off for the workspace, and the server says so
      // plainly — surfaced rather than swallowed, because "nothing happened" is the worst answer.
      toast.error("Could not explain the score", { description: serverMessage(err, "Try again.") });
    } finally {
      setNarrating(false);
    }
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Risk score</p>
          <p className="text-2xl font-black tabular-nums">
            {change.riskScore}
            <span className="text-base font-normal text-muted-foreground">/100</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={CHANGE_RISK_TONE[change.riskLevel]}>{humanizeChange(change.riskLevel)}</Badge>
          {/* Explains the score; never sets it. The number above is computed from the answers below
              and stored — a model inventing it would make the rule that decides whether a backout
              plan is mandatory unreproducible. This is its cover letter. */}
          <Button variant="ai" size="sm" disabled={narrating} onClick={() => void explain()}>
            {narrating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Explain this score
          </Button>
        </div>
        {unanswered > 0 && (
          <p className="text-xs text-warning">
            {unanswered} question{unanswered === 1 ? "" : "s"} unanswered — all are required before submitting, because a blank
            counts as nothing and would understate the score.
          </p>
        )}
      </div>

      {/* BorderGlow is the app-wide marker for "this surface is the model talking", and the sweep
          fires when the answer lands. Kept visually distinct from the recorded assessment below it,
          because one of the two is a record and the other is a paragraph about it. */}
      {narrative && (
        <BorderGlow animated>
          <div className="grid gap-1.5 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What this score means</p>
            <p className="text-sm leading-relaxed">{narrative}</p>
            <p className="text-[11px] text-muted-foreground">
              Written from the answers recorded below. It explains the score — it did not set it, and it is not a
              recommendation to approve.
            </p>
          </div>
        </BorderGlow>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {parameters.map((p) => (
          <PickField
            key={p.id}
            label={p.label}
            hint={`Weight ${p.weight}`}
            disabled={disabled}
            value={inputs[p.key] ?? null}
            options={changeBands.map(band)}
            onSave={(v) => onSave({ riskInputs: { ...inputs, [p.key]: v } })}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        The level is derived from these answers and the weights an admin configured — it is never typed, and it is frozen on the
        change once approved so retuning the matrix cannot rewrite what was agreed.
      </p>
    </div>
  );
}

/** The window, plus whatever it collides with. Conflicts are reported, never refused. */
/** Drafts the post-implementation review, as a proposal. See the route for why it is not a write. */
function PirAssistButton({ changeId }: { changeId: string }) {
  const [busy, setBusy] = useState(false);
  const [proposalId, setProposalId] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      const result = await changeApi.pirAssist(changeId);
      if (!result.proposalId) {
        toast.info("Nothing to draft", { description: result.message ?? "There is nothing recorded to review yet." });
        return;
      }
      setProposalId(result.proposalId);
      toast.success("Review drafted", { description: "Nothing has been written yet — accept it if it reads right." });
    } catch (err: any) {
      toast.error("Could not draft the review", { description: serverMessage(err, "Try again.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ai" size="sm" disabled={busy} onClick={() => void run()}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        Draft it from what happened
      </Button>
      {proposalId && (
        <Link to="/app/proposals" className="text-xs font-medium text-primary hover:underline">
          Review and accept it →
        </Link>
      )}
    </div>
  );
}

function ScheduleSection({
  change,
  disabled,
  onSave
}: {
  change: ChangeDetailRow;
  disabled: boolean;
  onSave: (p: Record<string, unknown>) => void;
}) {
  const conflicts = useQuery({
    queryKey: ["change", change.id, "conflicts", change.plannedStart, change.plannedEnd],
    queryFn: () => changeApi.conflicts(change.id),
    enabled: Boolean(change.plannedStart && change.plannedEnd)
  });
  const found = conflicts.data?.conflicts ?? [];
  const [brief, setBrief] = useState<string | null>(null);
  const [briefing, setBriefing] = useState(false);

  const explainConflicts = async () => {
    setBriefing(true);
    try {
      const result = await changeApi.conflictBrief(change.id);
      // A null brief is not a failure — it means nothing collides, which the server says plainly.
      setBrief(result.brief ?? result.message ?? "Nothing else is booked against this window.");
    } catch (err: any) {
      toast.error("Could not read the conflicts", { description: serverMessage(err, "Try again.") });
    } finally {
      setBriefing(false);
    }
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Window opens"
          required
          type="datetime-local"
          disabled={disabled}
          value={toLocalInput(change.plannedStart)}
          onSave={(v) => onSave({ plannedStart: v ? new Date(v).toISOString() : null })}
        />
        <TextField
          label="Window closes"
          required
          type="datetime-local"
          disabled={disabled}
          value={toLocalInput(change.plannedEnd)}
          onSave={(v) => onSave({ plannedEnd: v ? new Date(v).toISOString() : null })}
        />
      </div>

      {found.length > 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning/5 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-warning">
            <AlertTriangle className="h-3.5 w-3.5" />
            {found.length} scheduling conflict{found.length === 1 ? "" : "s"}
          </p>
          <ul className="mt-1.5 grid gap-1 text-sm text-muted-foreground">
            {found.map((c, i) => (
              <li key={`${c.kind}-${i}`}>· {c.message}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            Reported, not blocked — sometimes two changes genuinely do share a window. Overriding records a reason against the change.
          </p>
          {/* The overlaps above are arithmetic; this reads which of them matters. It moves nothing,
              so the scheduler still decides. */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button variant="ai" size="sm" disabled={briefing} onClick={() => void explainConflicts()}>
              {briefing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              Which of these matters?
            </Button>
          </div>
          {brief && (
            <BorderGlow animated className="mt-2">
              <p className="p-3 text-sm leading-relaxed">{brief}</p>
            </BorderGlow>
          )}
          <div className="mt-2">
            <TextField
              label="Override reason"
              disabled={disabled}
              value={change.conflictOverrideReason}
              placeholder="Why this window is going ahead anyway"
              onSave={(v) => onSave({ conflictOverrideReason: v || null })}
            />
          </div>
        </div>
      )}

      {found.length === 0 && change.plannedStart && (
        <p className="flex items-center gap-1.5 text-xs text-success">
          <CheckCircle2 className="h-3.5 w-3.5" />
          No blackout period or approved change overlaps this window.
        </p>
      )}
    </div>
  );
}

/** Tickets this change delivers, and the people working on it. */
function TaggingSection({ change, disabled, onChanged }: { change: ChangeDetailRow; disabled: boolean; onChanged: () => void }) {
  const [ticketQuery, setTicketQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  const linkable = useQuery({
    queryKey: ["change", change.id, "linkable", ticketQuery],
    queryFn: () => changeApi.linkableTickets(change.id, ticketQuery || undefined)
  });
  const users = useQuery({ queryKey: ["users", "pickable"], queryFn: () => userApi.list() });

  /** Hoisted out of the checkbox's handler: three closures deep inside a map inside JSX is where a
   *  reader stops being able to see what `p` refers to. */
  const togglePicked = (ticketId: string, checked: boolean) =>
    setPicked((current) => (checked ? [...current, ticketId] : current.filter((x) => x !== ticketId)));

  const link = useMutation({
    mutationFn: (ids: string[]) => changeApi.linkTickets(change.id, ids),
    onSuccess: () => {
      toast.success("Tickets linked");
      setPicked([]);
      onChanged();
    },
    onError: (err: any) => toast.error("Could not link", { description: serverMessage(err, "Try again.") })
  });
  const unlink = useMutation({
    mutationFn: (ticketId: string) => changeApi.unlinkTicket(change.id, ticketId),
    onSuccess: onChanged
  });
  const addPeople = useMutation({
    mutationFn: (userId: string) => changeApi.addCollaborators(change.id, [userId]),
    onSuccess: () => {
      toast.success("Added");
      onChanged();
    },
    onError: (err: any) => toast.error("Could not add", { description: serverMessage(err, "Try again.") })
  });
  const removePerson = useMutation({ mutationFn: (userId: string) => changeApi.removeCollaborator(change.id, userId), onSuccess: onChanged });

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <Label className="text-sm">Tickets delivered by this change</Label>
        <p className="text-xs text-muted-foreground">
          Only closed tickets from this change&apos;s own project can be linked — a change records work that is finished, not work
          that is promised.
        </p>

        <div className="flex flex-wrap gap-1.5">
          {change.linkedTickets.map((l) => (
            <span key={l.id} className="inline-flex items-center gap-1.5 rounded-full border border-border py-1 pl-2.5 pr-1.5 text-xs">
              <span className="font-mono text-muted-foreground">{l.ticket.key}</span>
              <span className="max-w-[220px] truncate">{l.ticket.title}</span>
              {!disabled && (
                <button type="button" aria-label={`Unlink ${l.ticket.key}`} onClick={() => unlink.mutate(l.ticketId)} className="text-muted-foreground hover:text-destructive">
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
          {change.linkedTickets.length === 0 && <span className="text-xs text-muted-foreground">No tickets linked yet.</span>}
        </div>

        {!disabled && (
          <div className="grid gap-2 rounded-lg border border-border p-3">
            <Input placeholder="Search closed tickets by key or title…" value={ticketQuery} onChange={(e) => setTicketQuery(e.target.value)} />
            <div className="max-h-52 overflow-y-auto">
              {(linkable.data ?? []).map((t) => (
                <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-muted/50">
                  <input
                    type="checkbox"
                    checked={picked.includes(t.id)}
                    onChange={(e) => togglePicked(t.id, e.target.checked)}
                  />
                  <span className="font-mono text-xs text-muted-foreground">{t.key}</span>
                  <span className="min-w-0 truncate">{t.title}</span>
                  <Badge variant="muted" className="ml-auto">{t.status}</Badge>
                </label>
              ))}
              {(linkable.data ?? []).length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">No closed tickets match.</p>}
            </div>
            <div className="flex justify-end">
              <Button size="sm" disabled={picked.length === 0 || link.isPending} onClick={() => link.mutate(picked)}>
                <Plus className="h-3.5 w-3.5" />
                Link {picked.length || ""} ticket{picked.length === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-2">
        <Label className="text-sm">People working on this change</Label>
        <div className="flex flex-wrap gap-1.5">
          {change.collaborators.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs">
              {c.user.name}
              {c.roleLabel && <span className="text-muted-foreground">· {c.roleLabel}</span>}
              {!disabled && (
                <button type="button" aria-label={`Remove ${c.user.name}`} onClick={() => removePerson.mutate(c.userId)} className="text-muted-foreground hover:text-destructive">
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
          {change.collaborators.length === 0 && <span className="text-xs text-muted-foreground">Nobody tagged yet.</span>}
        </div>
        {!disabled && (
          <div className="max-w-sm">
            <SearchableSelect
              aria-label="Add person"
              options={(users.data ?? [])
                .filter((u: any) => !change.collaborators.some((c) => c.userId === u.id))
                .map((u: any) => ({ id: u.id, name: u.name }))}
              value=""
              onChange={(v) => v && addPeople.mutate(v)}
              placeholder="+ Add someone"
              searchPlaceholder="Search people…"
              emptyText="No one matches."
            />
          </div>
        )}
      </div>
    </div>
  );
}
