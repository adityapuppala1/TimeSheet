/**
 * The Leave half of the Attendance & Leave settings tab (V17 UI v2): leave types, leave settings and
 * balance adjustments. Types are listed, created, edited and switched on or off — never deleted: a
 * type with history is disabled instead, exactly as the API enforces. Leave settings are STAGED with
 * the rest of the tab (the tab's sticky bar saves them); types and adjustments are actions with their
 * own confirmation, because each is one deliberate change rather than a setting.
 */
import { ScopePicker } from "../../components/attendance/ScopePicker";
import { scopeSummary } from "../../lib/employment-type";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plane, Plus, Scale } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { SearchableSelect } from "../../components/ui/searchable-select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toaster";
import { CardError } from "../../components/attendance/attendance-ui";
import { leaveColour } from "../../components/attendance/use-leave";
import { runInBackground } from "../../lib/run-in-background";
import { userApi } from "../../services/api";
import { leaveAdminApi, type LeaveSettings, type LeaveTypeRow } from "../../services/leave-api";
import { StagedNumber, StagedSegment, StagedSelect, StagedToggle } from "./attendance-fields";

const serverMessage = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

export const LEAVE_TYPES_KEY = ["leave-admin", "types"] as const;
export const LEAVE_SETTINGS_KEY = ["leave-admin", "settings"] as const;

const COLOURS = ["primary", "success", "warning", "info", "accent", "destructive"] as const;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/* --------------------------------- leave types --------------------------------- */

interface TypeForm {
  code: string;
  name: string;
  colour: string;
  annualQuota: number;
  accrual: "YEARLY_UPFRONT" | "MONTHLY_PRORATA";
  carryForwardMax: number;
  allowHalfDay: boolean;
  isPaid: boolean;
  requiresApproval: boolean;
  requiresDocumentAfterDays: number | null;
  allowNegative: boolean;
  enabled: boolean;
  /** 7.0.0: empty = everyone on that axis. */
  scopeEmploymentTypes: string[];
  scopeSiteIds: string[];
  sandwichRule: boolean;
}

const BLANK: TypeForm = {
  code: "",
  name: "",
  colour: "primary",
  annualQuota: 12,
  accrual: "MONTHLY_PRORATA",
  carryForwardMax: 0,
  allowHalfDay: true,
  isPaid: true,
  requiresApproval: true,
  requiresDocumentAfterDays: null,
  allowNegative: false,
  enabled: true,
  scopeEmploymentTypes: [],
  scopeSiteIds: [],
  sandwichRule: false
};

function formFrom(t: LeaveTypeRow): TypeForm {
  return {
    code: t.code,
    name: t.name,
    colour: t.colour ?? "primary",
    annualQuota: t.annualQuota,
    accrual: t.accrual,
    carryForwardMax: t.carryForwardMax,
    allowHalfDay: t.allowHalfDay,
    isPaid: t.isPaid,
    requiresApproval: t.requiresApproval,
    requiresDocumentAfterDays: t.requiresDocumentAfterDays,
    allowNegative: t.allowNegative,
    enabled: t.enabled,
    scopeEmploymentTypes: t.scopeEmploymentTypes ?? [],
    scopeSiteIds: t.scopeSiteIds ?? [],
    sandwichRule: t.sandwichRule ?? false
  };
}

function quotaText(t: LeaveTypeRow): string {
  const accrual = t.accrual === "MONTHLY_PRORATA" ? "accrues monthly" : "all at once";
  const carry = t.carryForwardMax > 0 ? ` · carry up to ${t.carryForwardMax}` : "";
  return `${t.annualQuota} days a year · ${accrual}${carry}`;
}

export function LeaveTypesSection({ readOnly }: Readonly<{ readOnly: boolean }>) {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: LEAVE_TYPES_KEY, queryFn: leaveAdminApi.types });
  const [editing, setEditing] = useState<{ id: string | null; form: TypeForm } | null>(null);
  const refresh = () => runInBackground(queryClient.invalidateQueries({ queryKey: ["leave-admin"] }));

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => leaveAdminApi.updateType(id, { enabled }),
    onSuccess: refresh,
    onError: (err) => toast.error("Could not change that type", { description: serverMessage(err, "Try again.") })
  });
  const save = useMutation({
    mutationFn: async ({ id, form }: { id: string | null; form: TypeForm }) => {
      if (id) {
        // The code is the stable key and is not editable.
        return leaveAdminApi.updateType(id, { ...form, code: undefined });
      }
      return leaveAdminApi.createType({ ...form, sortOrder: ((q.data ?? []).length + 1) * 10 });
    },
    onSuccess: () => {
      toast.success("Saved");
      setEditing(null);
      refresh();
    },
    onError: (err) => toast.error("Could not save the leave type", { description: serverMessage(err, "Check the values and try again.") })
  });

  if (q.isLoading) return <Skeleton className="h-40 w-full" />;
  if (q.isError) return <CardError message="Leave types could not be loaded." onRetry={() => runInBackground(q.refetch())} />;
  const list = q.data ?? [];

  return (
    <div className="grid min-w-0 gap-3">
      <p className="text-xs text-muted-foreground">Types are never deleted: one with history is switched off instead, and its past requests and balances stay as they were.</p>
      {list.length === 0 && <EmptyState compact icon={Plane} title="No leave types yet" description="Add one (Privilege, Casual, Sick …) before switching leave on." />}
      <ul className="grid gap-2">
        {list.map((t) => (
          <li key={t.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border p-3">
            <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: leaveColour(t.colour) }} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-semibold">
                <span className="truncate">{t.name}</span>
                <span className="font-mono text-xs font-normal text-muted-foreground">{t.code}</span>
                {!t.isPaid && <Badge variant="muted">Unpaid</Badge>}
              </p>
              <p className="text-xs text-muted-foreground">{quotaText(t)}</p>
              {(t.scopeEmploymentTypes?.length || t.scopeSiteIds?.length) ? <p className="text-xs text-muted-foreground">Only for: {scopeSummary(t.scopeEmploymentTypes, t.scopeSiteIds)}</p> : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="w-7 text-right text-xs font-semibold text-muted-foreground" aria-hidden="true">
                {t.enabled ? "On" : "Off"}
              </span>
              <Switch checked={t.enabled} disabled={readOnly || toggle.isPending} onCheckedChange={(enabled) => toggle.mutate({ id: t.id, enabled })} aria-label={`${t.name}: ${t.enabled ? "on" : "off"}`} />
              {!readOnly && (
                <Button variant="ghost" size="icon" aria-label={`Edit ${t.name}`} onClick={() => setEditing({ id: t.id, form: formFrom(t) })}>
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {!readOnly && (
        <Button variant="outline" className="min-h-[44px] justify-self-start" onClick={() => setEditing({ id: null, form: BLANK })}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Add leave type
        </Button>
      )}
      <TypeDialog editing={editing} onClose={() => setEditing(null)} onChange={(form) => setEditing((e) => (e ? { ...e, form } : e))} onSave={() => editing && save.mutate(editing)} saving={save.isPending} />
    </div>
  );
}

function TypeDialog({
  editing,
  onClose,
  onChange,
  onSave,
  saving
}: Readonly<{ editing: { id: string | null; form: TypeForm } | null; onClose: () => void; onChange: (f: TypeForm) => void; onSave: () => void; saving: boolean }>) {
  const f = editing?.form;
  const set = (patch: Partial<TypeForm>) => f && onChange({ ...f, ...patch });
  const valid = Boolean(f && f.name.trim() && /^[A-Z][A-Z0-9_]{0,19}$/.test(f.code));
  return (
    <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing?.id ? "Edit leave type" : "New leave type"}</DialogTitle>
          <DialogDescription>Changes apply to new requests; days already taken keep their history.</DialogDescription>
        </DialogHeader>
        {f && (
          <div className="grid gap-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
              <div className="grid gap-1.5">
                <Label htmlFor="lt-name">Name</Label>
                <Input id="lt-name" value={f.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="Privilege leave" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lt-code">Code</Label>
                <Input id="lt-code" value={f.code} maxLength={20} disabled={Boolean(editing?.id)} onChange={(e) => set({ code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })} placeholder="PL" />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <StagedNumber id="lt-quota" label="Days a year" hint="Whole days. Zero for unlimited-by-approval types." value={f.annualQuota} min={0} max={366} disabled={false} onChange={(v) => set({ annualQuota: v })} />
              <StagedNumber id="lt-carry" label="Carry forward up to" hint="Days that roll into next year." value={f.carryForwardMax} min={0} max={366} disabled={false} onChange={(v) => set({ carryForwardMax: v })} />
            </div>
            <StagedSegment
              label="Accrual"
              value={f.accrual}
              disabled={false}
              onChange={(v) => set({ accrual: v })}
              options={[
                { value: "MONTHLY_PRORATA", label: "Monthly" },
                { value: "YEARLY_UPFRONT", label: "All at once" }
              ]}
            />
            <ScopePicker id="lt-scope" what="leave type" value={{ scopeEmploymentTypes: f.scopeEmploymentTypes, scopeSiteIds: f.scopeSiteIds }} onChange={(v) => set(v)} />
            <StagedSelect id="lt-colour" label="Colour" value={f.colour} disabled={false} onChange={(v) => set({ colour: v })} options={COLOURS.map((c) => [c, c[0].toUpperCase() + c.slice(1)] as [string, string])} />
            <div className="grid gap-2">
              <FlagRow id="lt-half" label="Allow half days" checked={f.allowHalfDay} onChange={(v) => set({ allowHalfDay: v })} />
              <FlagRow id="lt-paid" label="Paid leave" checked={f.isPaid} onChange={(v) => set({ isPaid: v })} />
              <FlagRow id="lt-approval" label="Needs approval" hint="Off means requests are approved automatically." checked={f.requiresApproval} onChange={(v) => set({ requiresApproval: v })} />
              <FlagRow
                id="lt-sandwich"
                label="Sandwich rule"
                hint="Weekends and holidays fully between leave days of one request count as leave (Friday to Monday costs 4 days, not 2). Only new requests are affected."
                checked={f.sandwichRule}
                onChange={(v) => set({ sandwichRule: v })}
              />
              <FlagRow id="lt-neg" label="Allow a negative balance" hint="Otherwise a request that would go below zero is declined." checked={f.allowNegative} onChange={(v) => set({ allowNegative: v })} />
              <FlagRow
                id="lt-doc"
                label="Ask for a document on long requests"
                checked={f.requiresDocumentAfterDays != null}
                onChange={(v) => set({ requiresDocumentAfterDays: v ? 2 : null })}
              >
                <StagedNumber id="lt-doc-days" label="Longer than (days)" hint="A request over this length needs a supporting document." value={f.requiresDocumentAfterDays ?? 2} min={0} max={366} disabled={false} onChange={(v) => set({ requiresDocumentAfterDays: v })} />
              </FlagRow>
            </div>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="ghost" className="min-h-[44px]" onClick={onClose}>
            Cancel
          </Button>
          <Button className="min-h-[44px]" disabled={!valid || saving} onClick={onSave}>
            {saving ? "Saving…" : "Save leave type"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FlagRow({ id, label, hint, checked, onChange, children }: Readonly<{ id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; children?: React.ReactNode }>) {
  return (
    <div className="grid gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor={id}>{label}</Label>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="w-7 text-right text-xs font-semibold text-muted-foreground" aria-hidden="true">
            {checked ? "On" : "Off"}
          </span>
          <Switch id={id} checked={checked} onCheckedChange={onChange} />
        </div>
      </div>
      {checked && children}
    </div>
  );
}

/* -------------------------------- leave settings -------------------------------- */

export function LeaveSettingsFields({
  saved,
  values,
  readOnly,
  enabledTypes,
  yearLockedMessage = null,
  onChange
}: Readonly<{
  saved: LeaveSettings;
  values: LeaveSettings;
  readOnly: boolean;
  enabledTypes: number;
  /** Set once leave has been requested or balances posted: the start month can no longer change. */
  yearLockedMessage?: string | null;
  onChange: (patch: Partial<LeaveSettings>) => void;
}>) {
  return (
    <div className="grid min-w-0 gap-3">
      <StagedToggle
        id="leave-enabled"
        emphasis
        label="Enable leave"
        hint={enabledTypes === 0 ? "Turn on at least one leave type first. Leave runs independently of attendance." : "People can request leave, approvers decide, and approved leave shows in day status and capacity."}
        checked={values.leaveEnabled}
        disabled={readOnly || (enabledTypes === 0 && !values.leaveEnabled)}
        changed={values.leaveEnabled !== saved.leaveEnabled}
        onChange={(v) => onChange({ leaveEnabled: v })}
      >
        <StagedSelect
          id="leave-year-start"
          label="Leave year starts in"
          hint={yearLockedMessage ?? "Balances reset, carry forward and expire on this boundary. Change it before anyone has taken leave."}
          value={String(values.leaveYearStartMonth)}
          disabled={readOnly || Boolean(yearLockedMessage)}
          onChange={(v) => onChange({ leaveYearStartMonth: Number(v) })}
          options={MONTHS.map((m, i) => [String(i + 1), m] as [string, string])}
        />
        <StagedSegment
          label="When a person has no manager"
          hint="Who may decide their requests. A super admin can always decide any request."
          value={values.leaveApprovalFallback}
          disabled={readOnly}
          onChange={(v) => onChange({ leaveApprovalFallback: v })}
          options={[
            { value: "ADMINS", label: "Any admin" },
            { value: "SUPER_ADMINS", label: "Super admins only" }
          ]}
        />
        <FlagRow
          id="leave-trust"
          label="Trust approvals from external systems"
          hint="An HRMS that says a request is approved is recorded as approved, with the days debited. Off, it lands as pending for a manager."
          checked={values.trustExternalApprovals}
          onChange={(v) => !readOnly && onChange({ trustExternalApprovals: v })}
        />
      </StagedToggle>
    </div>
  );
}

/* ------------------------------ balance adjustments ------------------------------ */

export function BalanceAdjustments({ readOnly }: Readonly<{ readOnly: boolean }>) {
  const types = useQuery({ queryKey: LEAVE_TYPES_KEY, queryFn: leaveAdminApi.types });
  const people = useQuery({ queryKey: ["leave-admin", "people"], queryFn: () => userApi.list(), staleTime: 5 * 60_000 });
  const [userId, setUserId] = useState("");
  const [typeId, setTypeId] = useState("");
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const options = useMemo(() => (people.data ?? []).map((u) => ({ id: u.id, name: u.name })), [people.data]);
  const amount = Number(delta);
  const valid = Boolean(userId && typeId && Number.isFinite(amount) && amount !== 0 && Math.abs(amount) <= 366 && reason.trim());

  const adjust = useMutation({
    mutationFn: () => leaveAdminApi.adjust({ userId, leaveTypeId: typeId, delta: amount, reason: reason.trim() }),
    onSuccess: () => {
      toast.success("Balance adjusted", { description: "It is in the person's ledger with your reason." });
      setDelta("");
      setReason("");
    },
    onError: (err) => toast.error("Could not adjust the balance", { description: serverMessage(err, "Try again.") })
  });

  return (
    <form
      className="grid min-w-0 gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) adjust.mutate();
      }}
    >
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        An adjustment adds or removes days in the current leave year. It is recorded in the person's ledger with your name and reason, and cannot be edited afterwards, only offset.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label>Person</Label>
          <SearchableSelect options={options} value={userId} onChange={setUserId} disabled={readOnly} placeholder="Pick a person" searchPlaceholder="Search people…" />
        </div>
        <div className="grid gap-1.5">
          <Label>Leave type</Label>
          <SearchableSelect options={(types.data ?? []).filter((t) => t.enabled).map((t) => ({ id: t.id, name: t.name }))} value={typeId} onChange={setTypeId} disabled={readOnly} placeholder="Pick a type" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="adj-delta">Days to add or remove</Label>
          <Input id="adj-delta" type="number" step="0.5" inputMode="decimal" placeholder="+2 or -1.5" value={delta} disabled={readOnly} onChange={(e) => setDelta(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="adj-reason">Reason</Label>
          <Input id="adj-reason" value={reason} maxLength={255} placeholder="Comp-off for the release weekend" disabled={readOnly} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      {!readOnly && (
        <Button type="submit" className="min-h-[44px] justify-self-start" disabled={!valid || adjust.isPending}>
          {adjust.isPending ? "Adjusting…" : "Adjust balance"}
        </Button>
      )}
    </form>
  );
}
