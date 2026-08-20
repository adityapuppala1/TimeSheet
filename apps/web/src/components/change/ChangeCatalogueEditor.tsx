/**
 * WHAT: the editor behind every Change Management dropdown — categories, sources, applications, risk
 * parameters, SLA stages, maintenance windows and blackout periods. Add a row, rename it, retune it,
 * disable it, delete it.
 *
 * WHY ONE COMPONENT FOR SEVEN CATALOGUES: they are the same interaction seven times over — a list of
 * rows with a handful of typed fields, an add form, an active toggle and a delete. Writing seven
 * screens is how the sixth one ends up without a disable toggle. What differs is a field list, so
 * that is the only thing each caller passes.
 *
 * WHY DISABLE IS THE PROMINENT ACTION AND DELETE IS NOT: a change is a record of something that
 * happened, and retiring a category must not orphan the changes filed under it. The server refuses
 * any delete that would strand history and says how many records it found; this surfaces that
 * refusal as guidance rather than an error, because disabling is almost always what was meant.
 *
 * WHO USES IT: `pages/settings/ChangeManagementSettingsCard.tsx`, once per catalogue.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { changeApi, type ChangeCatalogueKind, type ChangeCatalogueRow } from "../../services/api";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toaster";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

export interface CatalogueField {
  name: string;
  label: string;
  type: "text" | "number" | "select" | "datetime" | "bool";
  /** Required on the add form. Optional fields can still be edited in place afterwards. */
  required?: boolean;
  options?: string[];
  placeholder?: string;
  /** Width hint for the row grid. Defaults to a single share. */
  span?: number;
  hint?: string;
}

const ENVIRONMENTS = ["DEVELOPMENT", "QA", "UAT", "STAGING", "PRODUCTION", "DR"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Minutes past midnight ⇄ "HH:MM". Stored as an integer so a window can cross midnight without a
 *  second row; shown as a clock time because nobody thinks in minutes past midnight. */
const toClock = (minutes: unknown): string => {
  const n = Number(minutes ?? 0);
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
};
const fromClock = (value: string): number => {
  const [h, m] = value.split(":").map((v) => Number(v) || 0);
  return Math.max(0, Math.min(1439, h * 60 + m));
};

/** The field lists. Exported so the settings card stays a layout and this file stays the vocabulary. */
export const CATALOGUE_FIELDS: Record<ChangeCatalogueKind, CatalogueField[]> = {
  categories: [
    { name: "name", label: "Name", type: "text", required: true, span: 2, placeholder: "Application release" },
    { name: "requiresSecurityReview", label: "Security review", type: "bool", hint: "Adds a security approver to this category's chain." },
    { name: "order", label: "Order", type: "number" }
  ],
  sources: [
    { name: "name", label: "Name", type: "text", required: true, span: 2, placeholder: "Incident" },
    { name: "order", label: "Order", type: "number" }
  ],
  applications: [
    { name: "name", label: "Name", type: "text", required: true, span: 2, placeholder: "Payments API" },
    { name: "code", label: "Code", type: "text", placeholder: "PAY" }
  ],
  "risk-parameters": [
    { name: "key", label: "Key", type: "text", required: true, placeholder: "rollbackComplexity", hint: "Letters, digits and underscores. The scoring engine reads this." },
    { name: "label", label: "Question", type: "text", required: true, span: 2, placeholder: "How complex is the rollback?" },
    { name: "weight", label: "Weight", type: "number", hint: "Contribution at the highest band. Scores normalise against the sum of active weights." },
    { name: "order", label: "Order", type: "number" }
  ],
  sla: [
    { name: "stage", label: "Stage", type: "text", required: true, placeholder: "APPROVAL" },
    { name: "hours", label: "Budget (hours)", type: "number" },
    { name: "warnAtPct", label: "Warn at %", type: "number", hint: "Fraction of the budget at which the stage starts warning rather than breaching." }
  ],
  "maintenance-windows": [
    { name: "name", label: "Name", type: "text", required: true, span: 2, placeholder: "Saturday night" },
    { name: "environment", label: "Environment", type: "select", options: ENVIRONMENTS },
    { name: "dayOfWeek", label: "Day", type: "select", options: DAYS, required: true },
    { name: "startMinute", label: "Starts", type: "text", required: true, placeholder: "22:00" },
    { name: "endMinute", label: "Ends", type: "text", required: true, placeholder: "02:00" }
  ],
  blackouts: [
    { name: "name", label: "Name", type: "text", required: true, span: 2, placeholder: "Year-end freeze" },
    { name: "environment", label: "Environment", type: "select", options: ENVIRONMENTS },
    { name: "startsAt", label: "Starts", type: "datetime", required: true },
    { name: "endsAt", label: "Ends", type: "datetime", required: true },
    { name: "reason", label: "Reason", type: "text", span: 2, placeholder: "No production change during close" }
  ]
};

/** Turns a form value into what the API expects for that field. */
function encode(field: CatalogueField, raw: unknown): unknown {
  if (field.name === "startMinute" || field.name === "endMinute") return fromClock(String(raw ?? "00:00"));
  if (field.name === "dayOfWeek") return DAYS.indexOf(String(raw));
  if (field.type === "number") return raw === "" || raw === null || raw === undefined ? undefined : Number(raw);
  if (field.type === "datetime") return raw ? new Date(String(raw)).toISOString() : undefined;
  if (field.type === "bool") return Boolean(raw);
  const text = String(raw ?? "").trim();
  return text === "" ? undefined : text;
}

/** …and back, for rendering an existing row. */
function decode(field: CatalogueField, raw: unknown): string {
  if (field.name === "startMinute" || field.name === "endMinute") return toClock(raw);
  if (field.name === "dayOfWeek") return DAYS[Number(raw ?? 0)] ?? DAYS[0];
  if (field.type === "datetime") return raw ? new Date(String(raw)).toISOString().slice(0, 16) : "";
  return raw === null || raw === undefined ? "" : String(raw);
}

export function ChangeCatalogueEditor({
  kind,
  title,
  description,
  readOnly
}: {
  kind: ChangeCatalogueKind;
  title: string;
  description: string;
  readOnly: boolean;
}) {
  const fields = CATALOGUE_FIELDS[kind];
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);

  const rows = useQuery({
    queryKey: ["change-config", kind],
    // Disabled rows included — this is the screen that has to show them to re-enable them.
    queryFn: () => changeApi.configList(kind, true)
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["change-config", kind] });
  const fail = (err: any) => toast.error("Could not save", { description: serverMessage(err, "Try again.") });

  const update = useMutation({
    mutationFn: (v: { id: string; body: Record<string, unknown> }) => changeApi.configUpdate(kind, v.id, v.body),
    onSuccess: refresh,
    onError: fail
  });
  const remove = useMutation({
    mutationFn: (id: string) => changeApi.configRemove(kind, id),
    onSuccess: () => {
      toast.success("Removed");
      refresh();
    },
    // The 409 is guidance, not a failure: it means live records point at this row, and disabling is
    // what was meant. The server's message already names the count.
    onError: (err: any) => toast.error("Still in use", { description: serverMessage(err, "Disable it instead.") })
  });

  const submit = async () => {
    const missing = fields.filter((f) => f.required && !String(draft[f.name] ?? "").trim());
    if (missing.length > 0) {
      toast.error("Fill the required fields", { description: missing.map((f) => f.label).join(", ") });
      return;
    }
    const body: Record<string, unknown> = {};
    for (const f of fields) {
      const value = encode(f, draft[f.name]);
      if (value !== undefined) body[f.name] = value;
    }
    setAdding(true);
    try {
      await changeApi.configCreate(kind, body);
      setDraft({});
      refresh();
      toast.success(`${title} added`);
    } catch (err: any) {
      fail(err);
    } finally {
      setAdding(false);
    }
  };

  const list = rows.data ?? [];

  return (
    <section className="grid gap-3 rounded-lg border border-border p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold text-foreground">{title}</h4>
          <Badge variant="muted">{list.length}</Badge>
        </div>
        <p className="max-w-xl text-xs text-muted-foreground">{description}</p>
      </header>

      {rows.isLoading ? (
        <p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>
      ) : list.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">Nothing here yet.</p>
      ) : (
        <ul className="grid gap-1.5">
          {list.map((row) => (
            <CatalogueRow
              key={row.id}
              row={row}
              fields={fields}
              readOnly={readOnly}
              onField={(name, value) => update.mutate({ id: row.id, body: { [name]: value } })}
              onToggle={(isActive) => update.mutate({ id: row.id, body: { isActive } })}
              onDelete={() => remove.mutate(row.id)}
            />
          ))}
        </ul>
      )}

      {!readOnly && (
        <div className="grid gap-2 rounded-md bg-muted/40 p-2.5">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {fields.map((f) => (
              <div key={f.name} className={cn("grid gap-1", f.span === 2 && "sm:col-span-2")}>
                <Label className="text-xs" htmlFor={`${kind}-${f.name}`}>
                  {f.label}
                  {f.required && <span className="ml-0.5 text-destructive">*</span>}
                </Label>
                <FieldInput
                  id={`${kind}-${f.name}`}
                  field={f}
                  value={draft[f.name] ?? ""}
                  onChange={(v) => setDraft((d) => ({ ...d, [f.name]: v }))}
                />
                {f.hint && <p className="text-[10px] leading-snug text-muted-foreground">{f.hint}</p>}
              </div>
            ))}
          </div>
          <div>
            <Button size="sm" onClick={() => void submit()} disabled={adding}>
              {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Add
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function FieldInput({
  id,
  field,
  value,
  onChange
}: {
  id?: string;
  field: CatalogueField;
  value: string;
  onChange: (v: string) => void;
}) {
  if (field.type === "select") {
    return (
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-8 min-w-0">
          <SelectValue placeholder="Choose" />
        </SelectTrigger>
        <SelectContent>
          {(field.options ?? []).map((o) => (
            <SelectItem key={o} value={o}>
              {o.charAt(0) + o.slice(1).toLowerCase()}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (field.type === "bool") {
    return (
      <div className="flex h-8 items-center">
        <Switch id={id} checked={value === "true"} onCheckedChange={(v) => onChange(String(v))} />
      </div>
    );
  }
  return (
    <Input
      id={id}
      className="h-8 min-w-0"
      type={field.type === "number" ? "number" : field.type === "datetime" ? "datetime-local" : "text"}
      value={value}
      placeholder={field.placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function CatalogueRow({
  row,
  fields,
  readOnly,
  onField,
  onToggle,
  onDelete
}: {
  row: ChangeCatalogueRow;
  fields: CatalogueField[];
  readOnly: boolean;
  onField: (name: string, value: unknown) => void;
  onToggle: (isActive: boolean) => void;
  onDelete: () => void;
}) {
  return (
    <li className={cn("grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_auto]", !row.isActive && "opacity-60")}>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {fields.map((f) => (
          <div key={f.name} className={cn("grid min-w-0 gap-0.5", f.span === 2 && "sm:col-span-2")}>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{f.label}</span>
            {readOnly ? (
              <span className="truncate text-sm">{decode(f, row[f.name]) || "—"}</span>
            ) : (
              <FieldInput
                field={f}
                value={f.type === "bool" ? String(Boolean(row[f.name])) : decode(f, row[f.name])}
                onChange={(v) => {
                  const encoded = encode(f, v);
                  if (encoded !== undefined) onField(f.name, encoded);
                }}
              />
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2">
        {/* Disable, not delete, is the everyday action — it takes the row out of the form and leaves
            every record filed under it readable. */}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch checked={row.isActive} disabled={readOnly} onCheckedChange={onToggle} aria-label="Active" />
          {row.isActive ? "On" : "Off"}
        </label>
        {!readOnly && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            aria-label="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </li>
  );
}
