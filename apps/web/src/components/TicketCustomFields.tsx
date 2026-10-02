/**
 * WHAT: the custom fields an admin defined, rendered on ONE ticket — read for everyone who can see
 * the ticket, editable for anyone who may work on it.
 *
 * WHY THIS EXISTS: fields were definable (Workspace settings → Planning), and blueprints and public
 * request forms wrote values into them, but no ticket screen ever read or edited those values. A
 * form that fills a field nobody can see is a form that lies.
 *
 * WHICH FIELDS: `fieldsForTicket` (lib/custom-fields.ts) — the same "applies to this type" rule the
 * API uses to skip type-scoped fields, so the section never offers a field the save would drop.
 *
 * SAVES PER FIELD, NOT PER FORM. A select or checkbox saves on change; a typed field saves on blur
 * or Enter. The server normalises and validates per type and replies with what it KEPT; that
 * reply replaces the local value, so a person always sees the stored truth (a "12,000" typed into
 * a number field comes back as 12000). A rejected value (required, bad URL, unknown option) shows
 * the server's message beside the field and the field keeps their input to fix.
 *
 * RENDERS NOTHING when no field applies — an empty "Fields" heading is noise on every ticket.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { planningApi, ticketApi, userApi, type CustomFieldRow } from "../services/api";
import { displayValue, editorValue, fieldsForTicket } from "../lib/custom-fields";
import { cn } from "../lib/utils";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { runInBackground } from "../lib/run-in-background";

const NONE = "__none__";

export function TicketCustomFields({ ticketId, ticketType, canEdit }: Readonly<{ ticketId: string; ticketType: string; canEdit: boolean }>) {
  const queryClient = useQueryClient();
  // Definitions are shared across every ticket and change once a quarter: one cache entry.
  const defs = useQuery({ queryKey: ["custom-fields"], queryFn: () => planningApi.listCustomFields(), staleTime: 5 * 60_000 });
  const values = useQuery({ queryKey: ["ticket", ticketId, "custom-fields"], queryFn: () => ticketApi.customFields.get(ticketId) });
  const fields = fieldsForTicket(defs.data, ticketType);
  const needsUsers = fields.some((f) => f.type === "USER");
  const users = useQuery({ queryKey: ["users"], queryFn: () => userApi.list(), enabled: needsUsers, staleTime: 60_000 });

  if (defs.isLoading || values.isLoading || fields.length === 0) return null;

  return (
    <section className="grid gap-2" aria-labelledby={`ticket-fields-${ticketId}`}>
      <Label id={`ticket-fields-${ticketId}`} className="text-xs uppercase text-muted-foreground">Fields</Label>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) => (
          <FieldEditor
            key={field.id}
            ticketId={ticketId}
            field={field}
            value={values.data?.[field.key]}
            users={users.data as Array<{ id: string; name: string }> | undefined}
            canEdit={canEdit}
            onSaved={(next) => {
              queryClient.setQueryData(["ticket", ticketId, "custom-fields"], next);
              runInBackground(queryClient.invalidateQueries({ queryKey: ["tickets"] }));
            }}
          />
        ))}
      </div>
    </section>
  );
}

function FieldEditor({
  ticketId,
  field,
  value,
  users,
  canEdit,
  onSaved
}: Readonly<{
  ticketId: string;
  field: CustomFieldRow;
  value: unknown;
  users?: ReadonlyArray<{ id: string; name: string }>;
  canEdit: boolean;
  onSaved: (all: Record<string, unknown>) => void;
}>) {
  const [draft, setDraft] = useState<string | string[] | boolean>(() => editorValue(field, value));
  const [error, setError] = useState<string | null>(null);
  // A save elsewhere (another field's read-back, another tab) refreshes what this editor holds —
  // unless the person is mid-edit with a rejected value they are still fixing.
  useEffect(() => {
    if (!error) setDraft(editorValue(field, value));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resync on stored value only
  }, [value]);

  const save = useMutation({
    mutationFn: (next: unknown) => ticketApi.customFields.set(ticketId, { [field.key]: next }),
    onSuccess: (all) => {
      setError(null);
      onSaved(all);
    },
    onError: (err: any) => setError(err?.response?.data?.message ?? "Could not save this field.")
  });

  const id = `cf-${ticketId}-${field.key}`;
  const label = (
    <Label htmlFor={id} className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
      {field.label}
      {field.isRequired && <span aria-hidden="true" className="text-destructive">*</span>}
      {save.isPending && <Loader2 className="h-3 w-3 animate-spin" aria-label="Saving" />}
      {save.isSuccess && !save.isPending && <Check className="h-3 w-3 text-success" aria-label="Saved" />}
    </Label>
  );

  if (!canEdit) {
    return (
      <div className="grid gap-1">
        {label}
        <p id={id} className="text-sm">{displayValue(field, value, users)}</p>
      </div>
    );
  }

  const commitText = () => {
    const stored = editorValue(field, value);
    if (draft === stored) {
      // Nothing to save — but if the previous attempt was rejected and the person has typed the
      // stored value back, the field is correct again and the message must go. Found live: the
      // early return kept "must be a number" beside a field that now held 12000.
      setError(null);
      return;
    }
    save.mutate(draft === "" ? null : draft);
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
  };
  const options = field.options ?? [];

  let control: React.ReactNode;
  switch (field.type) {
    case "CHECKBOX":
      control = (
        <div className="flex min-h-[44px] items-center gap-2">
          <Checkbox id={id} checked={Boolean(draft)} onCheckedChange={(c) => { setDraft(Boolean(c)); save.mutate(Boolean(c)); }} />
          <span className="text-sm">{draft ? "Yes" : "No"}</span>
        </div>
      );
      break;
    case "SINGLE_SELECT":
      control = (
        <Select value={(draft as string) || NONE} onValueChange={(v) => { const next = v === NONE ? "" : v; setDraft(next); save.mutate(next || null); }}>
          <SelectTrigger id={id}><SelectValue placeholder="Choose…" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>—</SelectItem>
            {options.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
          </SelectContent>
        </Select>
      );
      break;
    case "MULTI_SELECT": {
      const chosen = Array.isArray(draft) ? draft : [];
      control = (
        <div id={id} role="group" aria-label={field.label} className="flex flex-wrap gap-1.5">
          {options.map((o) => {
            const on = chosen.includes(o);
            return (
              <button
                key={o}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = on ? chosen.filter((c) => c !== o) : [...chosen, o];
                  setDraft(next);
                  save.mutate(next);
                }}
                className={cn(
                  "focus-ring min-h-[44px] rounded-full border px-3 text-xs font-medium transition-colors",
                  on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted"
                )}
              >
                {o}
              </button>
            );
          })}
        </div>
      );
      break;
    }
    case "USER":
      control = (
        <Select value={(draft as string) || NONE} onValueChange={(v) => { const next = v === NONE ? "" : v; setDraft(next); save.mutate(next || null); }}>
          <SelectTrigger id={id}><SelectValue placeholder="Choose a person…" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>—</SelectItem>
            {(users ?? []).map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
          </SelectContent>
        </Select>
      );
      break;
    case "DATE":
      control = <Input id={id} type="date" value={draft as string} onChange={(e) => setDraft(e.target.value)} onBlur={commitText} onKeyDown={onKey} />;
      break;
    case "NUMBER":
    case "CURRENCY":
      control = <Input id={id} inputMode="decimal" value={draft as string} onChange={(e) => setDraft(e.target.value)} onBlur={commitText} onKeyDown={onKey} placeholder={field.type === "CURRENCY" ? "0.00" : "0"} />;
      break;
    case "URL":
      control = <Input id={id} type="url" value={draft as string} onChange={(e) => setDraft(e.target.value)} onBlur={commitText} onKeyDown={onKey} placeholder="https://" />;
      break;
    default:
      control = <Input id={id} value={draft as string} onChange={(e) => setDraft(e.target.value)} onBlur={commitText} onKeyDown={onKey} />;
  }

  return (
    <div className="grid gap-1">
      {label}
      {control}
      {field.description && !error && <p className="text-[11px] text-muted-foreground">{field.description}</p>}
      {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
