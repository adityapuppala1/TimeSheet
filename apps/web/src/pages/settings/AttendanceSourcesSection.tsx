/**
 * "Sources & integrations" inside the Attendance & Leave settings tab (V17 A3): the inbound
 * sources (biometric/HRMS webhooks, API, CSV), their reveal-once signing secrets, a server-signed
 * test event, the delivery log with UNMATCHED replay, CSV import, and the priorities that decide
 * which source owns a day when two disagree.
 *
 * Locked (one sentence, no form) without attendanceIntegrationsEnabled: every route behind this is
 * refused server-side then, and a form whose every save 403s is worse than the explanation.
 */
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Bot, Copy, FileSpreadsheet, KeyRound, Plug, RefreshCw, RotateCcw, Send, Webhook } from "lucide-react";
import { SectionGroup } from "../../components/settings/settings-sections";
import { AttendanceConfirmDelete } from "./AttendanceConfirmDelete";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import { copyText } from "../../lib/clipboard";
import { runInBackground } from "../../lib/run-in-background";
import { SERVER_ORIGIN } from "../../services/api";
import {
  attendanceIntegrationsApi,
  type AttendanceEventStatus,
  type AttendanceMatchField,
  type AttendanceSettings,
  type AttendanceSourceKind,
  type AttendanceSourceRow,
  type CsvCommitSummary,
  type CsvPreview
} from "../../services/attendance-api";

const SOURCES_KEY = ["attendance-admin", "sources"] as const;
const EVENTS_KEY = ["attendance-admin", "events"] as const;
const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

const KIND_LABEL: Record<AttendanceSourceKind, string> = { WEBHOOK: "Webhook (device / HRMS)", API: "Public API", CSV: "CSV import" };
const MATCH_LABEL: Record<AttendanceMatchField, string> = { EMAIL: "Email", EMPLOYEE_CODE: "Employee code", EXTERNAL_ID: "External id (SCIM)" };
const STATUS_VARIANT: Record<AttendanceEventStatus, "success" | "muted" | "warning" | "destructive"> = {
  ACCEPTED: "success",
  DUPLICATE: "muted",
  SUPERSEDED: "muted",
  UNMATCHED: "warning",
  REJECTED: "destructive"
};

export function AttendanceSourcesSection({
  readOnly,
  locked,
  settings,
  onSaveSettings
}: {
  readOnly: boolean;
  locked: boolean;
  settings: AttendanceSettings;
  onSaveSettings: (payload: Partial<AttendanceSettings>) => void;
}) {
  if (locked) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-dashed border-border p-4">
        <Plug className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">
          Biometric devices, HRMS webhooks, the public API, MCP and CSV import are part of the Enterprise plan. Ask your
          platform administrator to change the plan.
        </p>
      </div>
    );
  }
  return (
    <SectionGroup>
      <SourcesList readOnly={readOnly} />
      <PrioritiesEditor readOnly={readOnly} settings={settings} onSave={onSaveSettings} />
      <ChannelsNote />
      <CsvImport readOnly={readOnly} />
      <DeliveryLog readOnly={readOnly} />
    </SectionGroup>
  );
}

/* ------------------------------------------------------------------ */

/** Loading / failed / empty / content, without a ternary ladder. */
function ListState({ loading, failed, empty, failText, emptyText, children }: { loading: boolean; failed: boolean; empty: boolean; failText: string; emptyText: string; children: ReactNode }) {
  if (loading) return <Skeleton className="h-20 w-full" />;
  if (failed) return <p className="text-sm text-destructive">{failText}</p>;
  if (empty) return <EmptyState compact icon={Plug} title={emptyText} />;
  return <>{children}</>;
}

function CopyField({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs" title={value}>{value}</code>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-9 w-9 shrink-0"
        aria-label={`Copy ${label}`}
        onClick={() => runInBackground(copyText(value).then((ok) => (ok ? toast.success("Copied") : toast.error("Could not copy — select and copy it by hand."))))}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function SourcesList({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const sources = useQuery({ queryKey: SOURCES_KEY, queryFn: attendanceIntegrationsApi.listSources });
  const refresh = () => runInBackground(queryClient.invalidateQueries({ queryKey: SOURCES_KEY }));
  const onError = (err: any) => toast.error("Could not save", { description: serverMessage(err, "Try again.") });
  const [revealed, setRevealed] = useState<{ id: string; secret: string } | null>(null);
  const [draft, setDraft] = useState<{ name: string; kind: AttendanceSourceKind; matchField: AttendanceMatchField }>({ name: "", kind: "WEBHOOK", matchField: "EMPLOYEE_CODE" });

  const create = useMutation({
    mutationFn: () => attendanceIntegrationsApi.createSource({ ...draft, name: draft.name.trim(), enabled: true }),
    onSuccess: (row) => {
      if (row.secret) setRevealed({ id: row.id, secret: row.secret });
      setDraft({ ...draft, name: "" });
      refresh();
    },
    onError
  });
  const update = useMutation({
    mutationFn: ({ id, ...payload }: { id: string } & Partial<Pick<AttendanceSourceRow, "enabled" | "priority" | "matchField">>) => attendanceIntegrationsApi.updateSource(id, payload),
    onSuccess: refresh,
    onError
  });
  const remove = useMutation({ mutationFn: (id: string) => attendanceIntegrationsApi.deleteSource(id), onSuccess: refresh, onError });
  const rotate = useMutation({
    mutationFn: (id: string) => attendanceIntegrationsApi.rotateSecret(id).then((r) => ({ id, secret: r.secret })),
    onSuccess: (r) => setRevealed(r),
    onError
  });
  const test = useMutation({
    mutationFn: (id: string) => attendanceIntegrationsApi.sendTestEvent(id),
    onSuccess: (r) => {
      toast.success("Test event delivered", { description: `Signed, verified and logged (${r.results[0]?.status ?? "?"}). No attendance was recorded.` });
      runInBackground(queryClient.invalidateQueries({ queryKey: EVENTS_KEY }));
      refresh();
    },
    onError: (err: any) => toast.error("Test event failed", { description: serverMessage(err, "Try again.") })
  });

  // Up/down swaps priorities with the neighbour — a keyboard- and phone-friendly stand-in for drag.
  const rows = sources.data ?? [];
  const move = (index: number, dir: -1 | 1) => {
    const a = rows[index];
    const b = rows[index + dir];
    if (!a || !b) return;
    const aPriority = a.priority === b.priority ? b.priority - dir : b.priority;
    update.mutate({ id: a.id, priority: aPriority });
    update.mutate({ id: b.id, priority: a.priority });
  };
  const origin = SERVER_ORIGIN || window.location.origin;

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <Webhook className="h-4 w-4 text-primary" aria-hidden />
        <h4 className="text-sm font-semibold">Sources</h4>
      </div>
      <p className="text-xs text-muted-foreground">
        Higher in the list wins when two sources disagree about the same person-day. The loser is kept in the delivery log.
      </p>
      {revealed && (
        <div className="grid gap-1.5 rounded-md border border-warning/40 bg-warning/5 p-3">
          <p className="text-xs font-semibold text-warning">Copy this signing secret now — it won't be shown again.</p>
          <CopyField value={revealed.secret} label="signing secret" />
          <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => setRevealed(null)}>I've saved it</Button>
        </div>
      )}
      <ListState loading={sources.isLoading} failed={sources.isError} empty={rows.length === 0} failText="Could not load sources." emptyText="No sources yet. Add a device or HRMS below.">
        <ul className="grid gap-2">
          {rows.map((s, i) => (
            <li key={s.id} className="grid min-w-0 gap-2 rounded-md border border-border p-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 truncate font-medium">{s.name}</span>
                <Badge variant="muted">{KIND_LABEL[s.kind]}</Badge>
                <Badge variant="muted">priority {s.priority}</Badge>
                <span className="text-xs text-muted-foreground">{s.lastEventAt ? `Last event ${new Date(s.lastEventAt).toLocaleString()}` : "No events yet"}</span>
                <div className="ml-auto flex items-center gap-1">
                  <Button size="icon" variant="ghost" className="h-9 w-9" aria-label={`Move ${s.name} up`} disabled={readOnly || i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-9 w-9" aria-label={`Move ${s.name} down`} disabled={readOnly || i === rows.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                  <Switch aria-label={`${s.name} enabled`} checked={s.enabled} disabled={readOnly} onCheckedChange={(v) => update.mutate({ id: s.id, enabled: v })} />
                  <AttendanceConfirmDelete
                    label={`Delete ${s.name}`}
                    title={`Delete "${s.name}"?`}
                    description="Its secret stops working immediately and the device or system can no longer send attendance. Past records and the delivery log are kept."
                    className="h-9 w-9 px-0 text-destructive hover:text-destructive"
                    iconClassName="h-4 w-4"
                    disabled={readOnly}
                    onConfirm={() => remove.mutate(s.id)}
                  />
                </div>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Label className="text-xs text-muted-foreground" htmlFor={`match-${s.id}`}>Match people by</Label>
                <Select value={s.matchField} disabled={readOnly} onValueChange={(v) => update.mutate({ id: s.id, matchField: v as AttendanceMatchField })}>
                  <SelectTrigger id={`match-${s.id}`} className="h-9 w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(MATCH_LABEL) as AttendanceMatchField[]).map((m) => <SelectItem key={m} value={m}>{MATCH_LABEL[m]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {s.webhookPath && (
                <div className="grid min-w-0 gap-1.5">
                  <CopyField value={`${origin}${s.webhookPath}`} label="webhook URL" />
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={readOnly || rotate.isPending} onClick={() => rotate.mutate(s.id)}>
                      <KeyRound className="mr-1.5 h-3.5 w-3.5" /> Rotate secret
                    </Button>
                    <Button size="sm" variant="outline" disabled={readOnly || !s.enabled || test.isPending} onClick={() => test.mutate(s.id)}>
                      <Send className="mr-1.5 h-3.5 w-3.5" /> Send test event
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </ListState>
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="New source name"
            className="min-w-0 flex-1 basis-48"
            maxLength={120}
            placeholder="e.g. Front door biometric"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <Select value={draft.kind} onValueChange={(v) => setDraft({ ...draft, kind: v as AttendanceSourceKind })}>
            <SelectTrigger aria-label="Kind" className="w-full sm:w-52"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(KIND_LABEL) as AttendanceSourceKind[]).map((k) => <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={draft.matchField} onValueChange={(v) => setDraft({ ...draft, matchField: v as AttendanceMatchField })}>
            <SelectTrigger aria-label="Match people by" className="w-full sm:w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(MATCH_LABEL) as AttendanceMatchField[]).map((m) => <SelectItem key={m} value={m}>{MATCH_LABEL[m]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button disabled={!draft.name.trim() || create.isPending} onClick={() => create.mutate()}>Add source</Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function PrioritiesEditor({ readOnly, settings, onSave }: { readOnly: boolean; settings: AttendanceSettings; onSave: (p: Partial<AttendanceSettings>) => void }) {
  const fields: Array<[keyof AttendanceSettings, string]> = [
    ["apiPriority", "Public API"],
    ["webPriority", "Web punch-in"],
    ["mcpPriority", "AI assistant (MCP)"],
    ["csvPriority", "CSV import"]
  ];
  return (
    <div className="grid gap-2">
      <h4 className="text-sm font-semibold">Priority of built-in channels</h4>
      <p className="text-xs text-muted-foreground">
        Webhook sources rank 1000 plus their own priority, so devices win by default. Raise a channel above 1000 to let it override them.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {fields.map(([key, label]) => (
          <div key={key} className="grid min-w-0 gap-1">
            <Label htmlFor={`prio-${key}`} className="text-xs">{label}</Label>
            <Input
              id={`prio-${key}`}
              type="number"
              min={-1000}
              max={5000}
              disabled={readOnly}
              defaultValue={Number(settings[key] ?? 0)}
              onBlur={(e) => {
                const next = Number(e.target.value);
                if (Number.isInteger(next) && next >= -1000 && next <= 5000 && next !== settings[key]) onSave({ [key]: next } as Partial<AttendanceSettings>);
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ChannelsNote() {
  return (
    <div className="grid gap-2 text-xs text-muted-foreground">
      <p className="flex items-start gap-2">
        <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>Public API: create a key under Public API with the <code>attendance:write</code> or <code>attendance:read</code> scope ticked. Existing keys have no attendance access.</span>
      </p>
      <p className="flex items-start gap-2">
        <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>MCP: <code>punch_in</code>, <code>get_my_attendance</code> and <code>list_holidays</code> act only as the signed-in person. Enable them under MCP server.</span>
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function CsvImport({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const [csv, setCsv] = useState("");
  const [matchField, setMatchField] = useState<AttendanceMatchField>("EMAIL");
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [summary, setSummary] = useState<CsvCommitSummary | null>(null);
  const onError = (err: any) => toast.error("Import failed", { description: serverMessage(err, "Try again.") });

  const check = useMutation({
    mutationFn: () => attendanceIntegrationsApi.previewCsv({ csv, matchField }),
    onSuccess: (p) => {
      setPreview(p);
      setSummary(null);
    },
    onError
  });
  const commit = useMutation({
    mutationFn: () => attendanceIntegrationsApi.commitCsv({ csv, matchField }),
    onSuccess: (s) => {
      setSummary(s);
      setPreview(null);
      runInBackground(queryClient.invalidateQueries({ queryKey: EVENTS_KEY }));
    },
    onError
  });

  let importLabel = "Import";
  if (preview) importLabel = preview.valid === 1 ? "Import 1 valid row" : `Import ${preview.valid} valid rows`;

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <FileSpreadsheet className="h-4 w-4 text-primary" aria-hidden />
        <h4 className="text-sm font-semibold">CSV import</h4>
      </div>
      <p className="text-xs text-muted-foreground">
        Columns: <code>identifier,date,punch_in,punch_out,external_ref</code> (the last two optional). Times as <code>HH:mm</code> in each
        person's own timezone, or full ISO timestamps. Up to 5,000 rows. Importing the same file twice changes nothing.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="file"
          accept=".csv,text/csv"
          aria-label="CSV file"
          className="min-w-0 flex-1 basis-56"
          disabled={readOnly}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            runInBackground(file.text().then((text) => {
              setCsv(text);
              setPreview(null);
              setSummary(null);
            }));
          }}
        />
        <Select value={matchField} onValueChange={(v) => setMatchField(v as AttendanceMatchField)}>
          <SelectTrigger aria-label="Identifier column holds" className="w-full sm:w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(MATCH_LABEL) as AttendanceMatchField[]).map((m) => <SelectItem key={m} value={m}>{MATCH_LABEL[m]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <Textarea aria-label="CSV text" rows={4} value={csv} disabled={readOnly} placeholder="…or paste CSV here" onChange={(e) => setCsv(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={readOnly || !csv.trim() || check.isPending} onClick={() => check.mutate()}>Validate</Button>
        <Button disabled={readOnly || !preview || preview.valid === 0 || preview.headerErrors.length > 0 || commit.isPending} onClick={() => commit.mutate()}>
          {importLabel}
        </Button>
      </div>
      {preview && (
        <div className="grid gap-2">
          {preview.headerErrors.map((e) => <p key={e} className="text-sm text-destructive">{e}</p>)}
          {preview.headerErrors.length === 0 && (
            <p className="text-sm">{preview.valid} of {preview.total} rows are valid. Rows with errors are skipped.</p>
          )}
          <div className="max-h-64 overflow-auto rounded-md border border-border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr><th className="p-2">Line</th><th className="p-2">Identifier</th><th className="p-2">Date</th><th className="p-2">In</th><th className="p-2">Person / errors</th></tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.line} className="border-t border-border align-top">
                    <td className="p-2">{r.line}</td>
                    <td className="max-w-[10rem] truncate p-2">{r.identifier}</td>
                    <td className="p-2">{r.date}</td>
                    <td className="p-2">{r.punchIn}</td>
                    <td className="p-2">{r.errors.length ? <span className="text-destructive">{r.errors.join("; ")}</span> : r.person?.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {summary && (
        <p className="text-sm">
          Imported: {summary.ACCEPTED} recorded, {summary.SUPERSEDED} kept for audit (a higher-priority source already had the day), {summary.DUPLICATE} already
          imported, {summary.skipped} skipped.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function DeliveryLog({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AttendanceEventStatus | "ALL">("ALL");
  const events = useQuery({
    queryKey: [...EVENTS_KEY, status],
    queryFn: () => attendanceIntegrationsApi.listEvents(status === "ALL" ? {} : { status })
  });
  const replay = useMutation({
    mutationFn: (id: string) => attendanceIntegrationsApi.replayEvent(id),
    onSuccess: (r) => {
      toast.success("Replayed", { description: r.status === "UNMATCHED" ? "Still no matching person — check their identifier." : `Result: ${r.status.toLowerCase()}.` });
      runInBackground(queryClient.invalidateQueries({ queryKey: EVENTS_KEY }));
    },
    onError: (err: any) => toast.error("Replay failed", { description: serverMessage(err, "Try again.") })
  });

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold">Delivery log</h4>
        <Select value={status} onValueChange={(v) => setStatus(v as AttendanceEventStatus | "ALL")}>
          <SelectTrigger aria-label="Filter by status" className="ml-auto h-9 w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(["ALL", "ACCEPTED", "UNMATCHED", "SUPERSEDED", "DUPLICATE", "REJECTED"] as const).map((s) => (
              <SelectItem key={s} value={s}>{s === "ALL" ? "All events" : s.charAt(0) + s.slice(1).toLowerCase()}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="icon" variant="ghost" className="h-9 w-9" aria-label="Refresh delivery log" onClick={() => runInBackground(events.refetch())}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ListState loading={events.isLoading} failed={events.isError} empty={(events.data?.events.length ?? 0) === 0} failText="Could not load the delivery log." emptyText="Nothing received yet.">
        <ul className="grid gap-1.5">
          {(events.data?.events ?? []).map((e) => (
            <li key={e.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
              <Badge variant={STATUS_VARIANT[e.status]}>{e.status.toLowerCase()}</Badge>
              {e.isTest && <Badge variant="muted">test</Badge>}
              <span className="font-medium">{e.sourceRef?.name ?? e.source}</span>
              <span className="min-w-0 truncate">{e.person ? e.person.name : e.identifier ?? "—"}</span>
              {e.workDate && <span className="text-muted-foreground">{e.workDate}</span>}
              {e.reason && <span className="w-full min-w-0 text-muted-foreground sm:w-auto sm:flex-1 sm:truncate" title={e.reason}>{e.reason}</span>}
              <span className="ml-auto text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</span>
              {e.status === "UNMATCHED" && !readOnly && (
                <Button size="sm" variant="outline" disabled={replay.isPending} onClick={() => replay.mutate(e.id)}>
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Replay
                </Button>
              )}
            </li>
          ))}
        </ul>
      </ListState>
    </div>
  );
}
