/**
 * The managed-backup console: what each tier allows, where backups go, what every workspace's
 * schedule is, and what the runs actually did.
 *
 * WHAT THIS SCREEN HAS TO BE HONEST ABOUT, because each one changes what an operator should do:
 *  - THE TIER IS A CEILING. A workspace on Team cannot be scheduled hourly, and the picker offers
 *    only what its plan permits rather than letting somebody choose a cadence the scheduler will
 *    quietly refuse. A policy that has drifted above its tier (a downgrade) is flagged, because the
 *    next tick will rewrite it and the operator should not learn that from a diff.
 *  - A DESTINATION IS NOT PROVEN UNTIL IT IS TESTED. The result of the last test is shown verbatim,
 *    and recorded rather than enforced — a bucket unreachable from a laptop can be perfectly
 *    reachable from the API host, so a failing test never blocks a save.
 *  - SECRETS ARE WRITE-ONLY. The console is told WHICH credential fields are set, never their
 *    values; leaving one blank on an edit keeps what is stored rather than clearing it, and the
 *    form says so.
 *  - RETENTION IS PREVIEWABLE. "Keep 7" and "GFS 7/4/12/3" are very different promises, so the
 *    preview asks the server what it WOULD keep and drop against the runs that exist, before
 *    anything is deleted.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CloudUpload,
  Database,
  HardDrive,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  XCircle
} from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/utils";
import {
  platformBackupApi,
  type BackupDestinationRow,
  type BackupFrequency,
  type BackupOverview,
  type BackupRunRow,
  type BackupWorkspaceRow
} from "../../services/platform-admin-api";
import {
  ConsoleSection,
  ConsoleTable,
  EmptyState,
  Field,
  FieldGrid,
  KpiCard,
  KpiGrid,
  Num,
  OrgStatusPill,
  PRIMARY_BTN,
  SwitchField,
  TierPill,
  Toolbar,
  relativeDay,
  shortDateTime
} from "./console-ui";

const errorMessageOf = (error: unknown) => (error as { response?: { data?: { message?: string } } })?.response?.data?.message;

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const KIND_ICON: Record<string, typeof Server> = {
  LOCAL: HardDrive,
  S3: CloudUpload,
  AZURE_BLOB: CloudUpload,
  GOOGLE_DRIVE: CloudUpload,
  ONEDRIVE: CloudUpload,
  SFTP: Server
};

const RUN_VARIANT: Record<string, "success" | "destructive" | "warning" | "info"> = {
  SUCCEEDED: "success",
  FAILED: "destructive",
  SKIPPED: "warning",
  RUNNING: "info"
};

/* ----------------------------------------------------------------------------------------- */
/* Destinations                                                                               */
/* ----------------------------------------------------------------------------------------- */

function DestinationDialog({ overview, editing, onClose }: { overview: BackupOverview; editing: BackupDestinationRow | "new" | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const isNew = editing === "new";
  const row = isNew ? null : editing;
  const [kind, setKind] = useState<BackupOverview["destinationKinds"][number]["kind"]>(row?.kind ?? "S3");
  const [name, setName] = useState(row?.name ?? "");
  const [orgId, setOrgId] = useState<string>(row?.organizationId ?? "platform");
  const [prefix, setPrefix] = useState(row?.prefix ?? "");
  const [config, setConfig] = useState<Record<string, string>>(() => ({ ...(row?.config ?? {}) }));
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  const spec = overview.destinationKinds.find((k) => k.kind === kind);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["platform-admin", "backups"] });

  const save = useMutation({
    mutationFn: async () => {
      const payload = { name, config, secrets, prefix: prefix.trim() || null };
      if (isNew) return platformBackupApi.createDestination({ ...payload, kind, organizationId: orgId === "platform" ? null : orgId });
      return platformBackupApi.updateDestination(row!.id, payload);
    },
    onSuccess: () => {
      toast.success(isNew ? "Destination added" : "Destination saved");
      invalidate();
      onClose();
    },
    onError: (e) => toast.error("Could not save", { description: errorMessageOf(e) })
  });

  if (!editing) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? "New backup destination" : `Edit ${row?.name}`}</DialogTitle>
          <DialogDescription>{spec?.blurb}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <FieldGrid cols={2}>
            <Field label="Name" htmlFor="dest-name" hint="What an operator will recognise it by.">
              <Input id="dest-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Primary S3 bucket" />
            </Field>
            {isNew && (
              <Field label="Kind" hint="Adding a kind is one entry in the API's field spec — the form is generated from it.">
                <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
                  <SelectTrigger aria-label="Destination kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {overview.destinationKinds.map((k) => (
                      <SelectItem key={k.kind} value={k.kind}>
                        {k.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            {isNew && (
              <Field label="Belongs to" hint="A platform destination can be used by any workspace; a workspace's own can only be used by it.">
                <Select value={orgId} onValueChange={setOrgId}>
                  <SelectTrigger aria-label="Owning workspace">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="platform">The platform (shared)</SelectItem>
                    {overview.workspaces.map((w) => (
                      <SelectItem key={w.organizationId} value={w.organizationId}>
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field label="Key prefix" htmlFor="dest-prefix" hint="Every object is written under this. Each workspace still gets its own folder inside it.">
              <Input id="dest-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="timesphere/" />
            </Field>
          </FieldGrid>

          <FieldGrid cols={2}>
            {spec?.fields.map((f) => {
              const alreadySet = row?.secretsSet?.[f.key];
              return (
                <Field
                  key={f.key}
                  label={
                    <span className="flex items-center gap-2">
                      {f.label}
                      {f.optional && <span className="text-xs font-normal text-muted-foreground">optional</span>}
                      {f.secret && alreadySet && <Badge variant="success">set</Badge>}
                    </span>
                  }
                  htmlFor={`dest-${f.key}`}
                  hint={f.secret && alreadySet ? `${f.hint ?? ""} Leave blank to keep the stored value.`.trim() : f.hint}
                >
                  <Input
                    id={`dest-${f.key}`}
                    type={f.secret ? "password" : "text"}
                    autoComplete={f.secret ? "new-password" : "off"}
                    placeholder={f.placeholder}
                    value={f.secret ? (secrets[f.key] ?? "") : (config[f.key] ?? "")}
                    onChange={(e) =>
                      f.secret
                        ? setSecrets((prev) => ({ ...prev, [f.key]: e.target.value }))
                        : setConfig((prev) => ({ ...prev, [f.key]: e.target.value }))
                    }
                  />
                </Field>
              );
            })}
          </FieldGrid>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button className={PRIMARY_BTN} disabled={name.trim().length < 2 || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : isNew ? "Add destination" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DestinationsTab({ overview }: { overview: BackupOverview }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<BackupDestinationRow | "new" | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["platform-admin", "backups"] });

  const test = useMutation({
    mutationFn: (id: string) => platformBackupApi.testDestination(id),
    onMutate: (id) => setTesting(id),
    onSettled: () => setTesting(null),
    onSuccess: (r) => {
      if (r.ok) toast.success("Destination reachable", { description: r.message });
      else toast.error("Could not reach it", { description: r.message });
      invalidate();
    },
    onError: (e) => toast.error("Test failed", { description: errorMessageOf(e) })
  });
  const remove = useMutation({
    mutationFn: (id: string) => platformBackupApi.deleteDestination(id),
    onSuccess: () => {
      toast.success("Destination removed");
      invalidate();
    },
    onError: (e) => toast.error("Not removed", { description: errorMessageOf(e) })
  });

  return (
    <ConsoleSection
      title="Destinations"
      description="Where backups are written. A platform destination is shared by every workspace, with each one's objects under its own folder; a workspace's own is private to it. Credentials are encrypted at rest and never sent back to this screen."
      actions={
        <Toolbar>
          <Button size="sm" className={cn("gap-1.5", PRIMARY_BTN)} onClick={() => setEditing("new")}>
            <Plus className="h-3.5 w-3.5" />New destination
          </Button>
        </Toolbar>
      }
      flush
    >
      {overview.destinations.length === 0 ? (
        <div className="p-4 sm:p-5">
          <EmptyState
            icon={CloudUpload}
            title="No destinations yet"
            description="Add an S3-compatible bucket, Azure Blob container, Google Drive folder, OneDrive folder, SFTP server or a local directory. Nothing can be scheduled until there is somewhere to write to."
          />
        </div>
      ) : (
        <ConsoleTable minWidth={880} className="rounded-none border-x-0 border-b-0">
          <TableHeader>
            <TableRow>
              <TableHead>Destination</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Last test</TableHead>
              <TableHead className="text-right">Runs</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {overview.destinations.map((d) => {
              const Icon = KIND_ICON[d.kind] ?? CloudUpload;
              return (
                <TableRow key={d.id}>
                  <TableCell className="max-w-[16rem]">
                    <span className="flex items-center gap-2">
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium text-foreground">{d.name}</span>
                    </span>
                    {d.prefix && <span className="block truncate font-mono text-[11px] text-muted-foreground">{d.prefix}</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {overview.destinationKinds.find((k) => k.kind === d.kind)?.label ?? d.kind}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {d.organizationId ? <span className="text-foreground">{d.organizationName}</span> : <Badge variant="info">Platform-wide</Badge>}
                  </TableCell>
                  <TableCell className="max-w-[18rem]">
                    {d.lastTestStatus ? (
                      <span className="flex flex-col gap-0.5">
                        <Badge variant={d.lastTestStatus === "PASS" ? "success" : "destructive"} className="w-fit gap-1">
                          {d.lastTestStatus === "PASS" ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                          {d.lastTestStatus === "PASS" ? "Reachable" : "Failed"}
                        </Badge>
                        {/* Verbatim: "AccessDenied" and "no such bucket" send somebody to two very
                            different places, and flattening them costs a round trip. */}
                        <span className="line-clamp-2 text-[11px] text-muted-foreground">{d.lastTestMessage}</span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Never tested</span>
                    )}
                  </TableCell>
                  <Num className="text-muted-foreground">{d.runCount}</Num>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={testing === d.id} onClick={() => test.mutate(d.id)}>
                        {testing === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                        <span className="sr-only sm:not-sr-only">Test</span>
                      </Button>
                      <Button size="sm" variant="outline" className="h-7" onClick={() => setEditing(d)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground hover:text-destructive" aria-label={`Delete ${d.name}`} onClick={() => remove.mutate(d.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </ConsoleTable>
      )}
      <DestinationDialog overview={overview} editing={editing} onClose={() => setEditing(null)} />
    </ConsoleSection>
  );
}

/* ----------------------------------------------------------------------------------------- */
/* Schedule editor                                                                            */
/* ----------------------------------------------------------------------------------------- */

function ScheduleDialog({ overview, workspace, onClose }: { overview: BackupOverview; workspace: BackupWorkspaceRow | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const p = workspace?.policy;
  const [form, setForm] = useState(() => ({
    enabled: p?.enabled ?? false,
    frequency: (p?.frequency ?? workspace?.entitlement.frequency ?? "NONE") as BackupFrequency,
    hourUtc: String(p?.hourUtc ?? 2),
    dayOfWeek: String(p?.dayOfWeek ?? 0),
    destinationId: p?.destinationId ?? "",
    retentionMode: p?.retentionMode ?? "COUNT",
    keepCount: String(p?.keepCount ?? 7),
    keepDays: String(p?.keepDays ?? 30),
    gfsDaily: String(p?.gfsDaily ?? 7),
    gfsWeekly: String(p?.gfsWeekly ?? 4),
    gfsMonthly: String(p?.gfsMonthly ?? 12),
    gfsYearly: String(p?.gfsYearly ?? 3),
    alertEmails: p?.alertEmails ?? "",
    alertWebhook: "",
    alertOnSuccess: p?.alertOnSuccess ?? false,
    alertOnFailure: p?.alertOnFailure ?? true
  }));

  const save = useMutation({
    mutationFn: () =>
      platformBackupApi.savePolicy(workspace!.organizationId, {
        enabled: form.enabled,
        frequency: form.frequency,
        hourUtc: Number(form.hourUtc),
        dayOfWeek: Number(form.dayOfWeek),
        destinationId: form.destinationId || null,
        retentionMode: form.retentionMode,
        keepCount: Number(form.keepCount),
        keepDays: Number(form.keepDays),
        gfsDaily: Number(form.gfsDaily),
        gfsWeekly: Number(form.gfsWeekly),
        gfsMonthly: Number(form.gfsMonthly),
        gfsYearly: Number(form.gfsYearly),
        alertEmails: form.alertEmails.trim() || null,
        ...(form.alertWebhook.trim() ? { alertWebhook: form.alertWebhook.trim() } : {}),
        alertOnSuccess: form.alertOnSuccess,
        alertOnFailure: form.alertOnFailure
      }),
    onSuccess: (r) => {
      toast.success("Schedule saved", { description: r.nextRunAt ? `Next run ${new Date(r.nextRunAt).toLocaleString()}` : "No run scheduled." });
      void queryClient.invalidateQueries({ queryKey: ["platform-admin", "backups"] });
      onClose();
    },
    onError: (e) => toast.error("Could not save", { description: errorMessageOf(e) })
  });

  if (!workspace) return null;
  const usable = overview.destinations.filter((d) => !d.organizationId || d.organizationId === workspace.organizationId);
  const noBackups = workspace.entitlement.frequency === "NONE";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Backup schedule — {workspace.name}</DialogTitle>
          <DialogDescription>
            On {workspace.entitlement.tier}, which allows{" "}
            <strong>{overview.frequencyLabels[workspace.entitlement.frequency].toLowerCase()}</strong> at most
            {workspace.entitlement.maxDestinations > 0 && ` and ${workspace.entitlement.maxDestinations} destination${workspace.entitlement.maxDestinations === 1 ? "" : "s"}`}.
          </DialogDescription>
        </DialogHeader>

        {noBackups ? (
          <EmptyState
            icon={AlertTriangle}
            title={`${workspace.entitlement.tier} does not include managed backups`}
            description="Raise the plan tier to schedule them. The pre-deletion snapshot the retention programme takes is separate and applies on every plan."
          />
        ) : (
          <div className="grid gap-4">
            <SwitchField
              label="Automatic backups on"
              hint="Off keeps the settings but runs nothing. Manual runs still work."
              checked={form.enabled}
              onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
            />

            <FieldGrid cols={3}>
              <Field label="Cadence" hint="Only what this workspace's plan allows is offered.">
                <Select value={form.frequency} onValueChange={(v) => setForm((f) => ({ ...f, frequency: v as BackupFrequency }))}>
                  <SelectTrigger aria-label="Cadence">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {workspace.allowedFrequencies.map((f) => (
                      <SelectItem key={f} value={f}>
                        {overview.frequencyLabels[f]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {form.frequency !== "HOURLY" && form.frequency !== "NONE" && (
                <Field label="Hour (UTC)" htmlFor="pol-hour" hint="Stored and shown in UTC — a platform in several timezones cannot mean “2am” without saying whose.">
                  <Input id="pol-hour" type="number" min={0} max={23} value={form.hourUtc} onChange={(e) => setForm((f) => ({ ...f, hourUtc: e.target.value }))} />
                </Field>
              )}
              {form.frequency === "WEEKLY" && (
                <Field label="Day">
                  <Select value={form.dayOfWeek} onValueChange={(v) => setForm((f) => ({ ...f, dayOfWeek: v }))}>
                    <SelectTrigger aria-label="Day of week">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DAY_NAMES.map((d, i) => (
                        <SelectItem key={d} value={String(i)}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              <Field label="Destination" hint={usable.length === 0 ? "None available — add one on the Destinations tab first." : undefined}>
                <Select value={form.destinationId} onValueChange={(v) => setForm((f) => ({ ...f, destinationId: v }))}>
                  <SelectTrigger aria-label="Destination">
                    <SelectValue placeholder="Choose…" />
                  </SelectTrigger>
                  <SelectContent>
                    {usable.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                        {!d.organizationId && " (shared)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </FieldGrid>

            <Field label="Retention" hint="How long copies are kept. Nothing is ever deleted before a newer backup has succeeded.">
              <Select value={form.retentionMode} onValueChange={(v) => setForm((f) => ({ ...f, retentionMode: v as typeof f.retentionMode }))}>
                <SelectTrigger aria-label="Retention mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="COUNT">Keep the newest N</SelectItem>
                  <SelectItem value="AGE">Keep everything younger than N days</SelectItem>
                  <SelectItem value="GFS">Grandfather-Father-Son rotation</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {form.retentionMode === "COUNT" && (
              <Field label="Keep how many" htmlFor="pol-count">
                <Input id="pol-count" type="number" min={1} value={form.keepCount} onChange={(e) => setForm((f) => ({ ...f, keepCount: e.target.value }))} />
              </Field>
            )}
            {form.retentionMode === "AGE" && (
              <Field label="Keep for how many days" htmlFor="pol-days" hint="The newest backup is never deleted, however old it is.">
                <Input id="pol-days" type="number" min={1} value={form.keepDays} onChange={(e) => setForm((f) => ({ ...f, keepDays: e.target.value }))} />
              </Field>
            )}
            {form.retentionMode === "GFS" && (
              <FieldGrid cols={2}>
                <Field label="Dailies" htmlFor="gfs-d">
                  <Input id="gfs-d" type="number" min={0} value={form.gfsDaily} onChange={(e) => setForm((f) => ({ ...f, gfsDaily: e.target.value }))} />
                </Field>
                <Field label="Weeklies" htmlFor="gfs-w">
                  <Input id="gfs-w" type="number" min={0} value={form.gfsWeekly} onChange={(e) => setForm((f) => ({ ...f, gfsWeekly: e.target.value }))} />
                </Field>
                <Field label="Monthlies" htmlFor="gfs-m">
                  <Input id="gfs-m" type="number" min={0} value={form.gfsMonthly} onChange={(e) => setForm((f) => ({ ...f, gfsMonthly: e.target.value }))} />
                </Field>
                <Field label="Yearlies" htmlFor="gfs-y" hint="One object fills every slot it qualifies for — the first backup of January is the daily, the weekly, the monthly and the yearly. No copies are made.">
                  <Input id="gfs-y" type="number" min={0} value={form.gfsYearly} onChange={(e) => setForm((f) => ({ ...f, gfsYearly: e.target.value }))} />
                </Field>
              </FieldGrid>
            )}

            <FieldGrid cols={2}>
              <Field label="Alert emails" htmlFor="pol-emails" hint="Comma separated. Sent through the platform relay — a workspace's own SMTP is the wrong sender for “your backup failed”, and may be what is broken.">
                <Input id="pol-emails" value={form.alertEmails} onChange={(e) => setForm((f) => ({ ...f, alertEmails: e.target.value }))} placeholder="ops@acme.com, oncall@acme.com" />
              </Field>
              <Field
                label={
                  <span className="flex items-center gap-2">
                    Slack / webhook URL {p?.hasAlertWebhook && <Badge variant="success">set</Badge>}
                  </span>
                }
                htmlFor="pol-hook"
                hint={p?.hasAlertWebhook ? "Leave blank to keep the stored URL. The URL is a credential, so it is encrypted and never shown." : "A Slack incoming webhook, or any HTTPS endpoint."}
              >
                <Input id="pol-hook" type="password" autoComplete="new-password" value={form.alertWebhook} onChange={(e) => setForm((f) => ({ ...f, alertWebhook: e.target.value }))} placeholder="https://hooks.slack.com/services/…" />
              </Field>
              <SwitchField label="Alert on failure" hint="A backup nobody is told about failing is the same as no backup." checked={form.alertOnFailure} onCheckedChange={(v) => setForm((f) => ({ ...f, alertOnFailure: v }))} />
              <SwitchField label="Alert on success" hint="Off by default — a daily success email is training to ignore the failure one." checked={form.alertOnSuccess} onCheckedChange={(v) => setForm((f) => ({ ...f, alertOnSuccess: v }))} />
            </FieldGrid>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button className={PRIMARY_BTN} disabled={noBackups || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------------------------------------- */
/* Page                                                                                       */
/* ----------------------------------------------------------------------------------------- */

export function BackupSchedulesTab() {
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ["platform-admin", "backups", "overview"], queryFn: platformBackupApi.overview });
  const [editing, setEditing] = useState<BackupWorkspaceRow | null>(null);
  const [tick, setTick] = useState<Awaited<ReturnType<typeof platformBackupApi.tick>> | null>(null);
  const d = overview.data;

  const runNow = useMutation({
    mutationFn: (orgId: string) => platformBackupApi.runNow(orgId),
    onSuccess: (r) => {
      toast.success("Backup complete", { description: r.message });
      void queryClient.invalidateQueries({ queryKey: ["platform-admin", "backups"] });
    },
    onError: (e) => toast.error("Backup failed", { description: errorMessageOf(e) })
  });
  const dryRun = useMutation({
    mutationFn: () => platformBackupApi.tick(true),
    onSuccess: (r) => {
      setTick(r);
      toast.success(`${r.due} workspace${r.due === 1 ? "" : "s"} due`);
    },
    onError: (e) => toast.error("Could not run the pass", { description: errorMessageOf(e) })
  });
  const testRestore = useMutation({
    mutationFn: (runId: string) => platformBackupApi.testRestore(runId),
    onSuccess: (r) => toast.success("Test restore passed", { description: r.message }),
    onError: (e) => toast.error("Test restore failed", { description: errorMessageOf(e) })
  });

  const stats = useMemo(() => {
    if (!d) return { scheduled: 0, failed: 0, bytes: 0, destinations: 0 };
    const week = Date.now() - 7 * 86_400_000;
    return {
      scheduled: d.workspaces.filter((w) => w.policy?.enabled).length,
      failed: d.recentRuns.filter((r) => r.status === "FAILED" && new Date(r.startedAt).getTime() >= week).length,
      bytes: d.recentRuns.filter((r) => r.status === "SUCCEEDED").reduce((sum, r) => sum + (r.bytes ?? 0), 0),
      destinations: d.destinations.length
    };
  }, [d]);

  if (overview.isLoading) return <Skeleton className="h-96 w-full" />;
  if (!d) return null;

  return (
    <div className="grid min-w-0 gap-6">
      <KpiGrid>
        <KpiCard label="Scheduled workspaces" value={stats.scheduled} icon={CalendarClock} tone="accent" hint={`of ${d.workspaces.length} on the platform`} />
        <KpiCard label="Destinations" value={stats.destinations} icon={CloudUpload} delay={0.05} />
        <KpiCard label="Failures, 7 days" value={stats.failed} icon={AlertTriangle} tone={stats.failed > 0 ? "destructive" : "default"} delay={0.1} />
        <KpiCard label="Stored, recent runs" value={stats.bytes} icon={Database} format={(n) => formatBytes(n)} delay={0.15} />
      </KpiGrid>

      <ConsoleSection
        title="What each plan allows"
        description="A ceiling, not a setting: a workspace chooses its own cadence and the scheduler clamps it to the tier on every tick, so a downgrade takes effect without anyone editing a policy."
        flush
      >
        <ConsoleTable minWidth={560} className="rounded-none border-x-0 border-b-0">
          <TableHeader>
            <TableRow>
              <TableHead>Plan</TableHead>
              <TableHead>Automatic backups</TableHead>
              <TableHead className="text-right">Destinations</TableHead>
              <TableHead>Test restore &amp; PITR</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.tiers.map((t) => (
              <TableRow key={t.tier}>
                <TableCell>
                  <TierPill tier={t.tier} />
                </TableCell>
                <TableCell className={cn("text-sm", t.backupFrequency === "NONE" && "text-muted-foreground")}>{t.backupFrequencyLabel}</TableCell>
                <Num>{t.maxBackupDestinations || "—"}</Num>
                <TableCell>{t.backupPitrEnabled ? <Badge variant="success">Included</Badge> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ConsoleTable>
      </ConsoleSection>

      <ConsoleSection
        title="Schedules"
        description="One policy per workspace. The scheduler runs at five past every hour and only touches policies that are due."
        actions={
          <Toolbar>
            <Button size="sm" variant="outline" className="gap-1.5" disabled={dryRun.isPending} onClick={() => dryRun.mutate()}>
              <Play className="h-3.5 w-3.5" />Dry run the pass
            </Button>
          </Toolbar>
        }
        flush
      >
        {tick && (
          <div className="border-b border-border bg-muted/40 px-4 py-3 text-xs sm:px-5">
            <p className="mb-1 font-mono uppercase tracking-wide text-muted-foreground">
              Dry run as of {shortDateTime(tick.now)} · {tick.due} due
            </p>
            {tick.ran.length === 0 && tick.clamped.length === 0 ? (
              <p className="text-muted-foreground">Nothing is due.</p>
            ) : (
              <ul className="grid gap-1 font-mono">
                {tick.ran.map((r) => (
                  <li key={`${r.slug}-run`} className="text-info">
                    would back up {r.slug} — {r.message}
                  </li>
                ))}
                {tick.clamped.map((c) => (
                  <li key={`${c.slug}-clamp`} className="text-warning">
                    {c.slug} asks for {c.asked.toLowerCase()} but its plan allows {c.allowed.toLowerCase()} — the next real pass will rewrite it
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <ConsoleTable minWidth={980} className="rounded-none border-x-0 border-b-0">
          <TableHeader>
            <TableRow>
              <TableHead>Workspace</TableHead>
              <TableHead>Plan allows</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead>Retention</TableHead>
              <TableHead className="text-right">Last run</TableHead>
              <TableHead className="text-right">Next run</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.workspaces.map((w) => {
              const p = w.policy;
              return (
                <TableRow key={w.organizationId}>
                  <TableCell className="max-w-[15rem]">
                    <span className="block truncate font-medium text-foreground">{w.name}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-mono text-[11px] text-muted-foreground">{w.slug}</span>
                      <OrgStatusPill status={w.status} />
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    <TierPill tier={w.trialTier ? `${w.trialTier} trial` : w.planTier} />
                    <span className="ml-1.5 text-muted-foreground">{d.frequencyLabels[w.entitlement.frequency]}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {p?.enabled ? (
                      <span className="flex items-center gap-1.5">
                        <Badge variant="success">{d.frequencyLabels[p.frequency]}</Badge>
                        {p.frequency !== "HOURLY" && <span className="text-muted-foreground">{String(p.hourUtc).padStart(2, "0")}:00 UTC</span>}
                        {p.frequency === "WEEKLY" && <span className="text-muted-foreground">{DAY_NAMES[p.dayOfWeek]}</span>}
                        {p.overTier && (
                          <Badge variant="warning" title="The plan no longer permits this cadence — the next pass will lower it.">
                            over plan
                          </Badge>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{p ? "Paused" : "Not configured"}</span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[12rem] truncate text-xs text-muted-foreground">{p?.destinationName ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {p
                      ? p.retentionMode === "COUNT"
                        ? `newest ${p.keepCount}`
                        : p.retentionMode === "AGE"
                          ? `${p.keepDays} days`
                          : `GFS ${p.gfsDaily}/${p.gfsWeekly}/${p.gfsMonthly}/${p.gfsYearly}`
                      : "—"}
                  </TableCell>
                  <Num className="text-muted-foreground">
                    {p?.lastRunAt ? (
                      <span className="flex items-center justify-end gap-1.5">
                        {p.lastStatus && <Badge variant={RUN_VARIANT[p.lastStatus] ?? "muted"}>{p.lastStatus.toLowerCase()}</Badge>}
                        {relativeDay(p.lastRunAt)}
                      </span>
                    ) : (
                      "never"
                    )}
                  </Num>
                  <Num className="text-muted-foreground">{p?.enabled ? relativeDay(p.projectedNextRunAt) : "—"}</Num>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="outline" className="h-7" onClick={() => setEditing(w)}>
                        Configure
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1.5"
                        disabled={!w.hasDatabase || !p?.destinationId || runNow.isPending}
                        title={!w.hasDatabase ? "This workspace has no database registered." : !p?.destinationId ? "No destination configured." : undefined}
                        onClick={() => runNow.mutate(w.organizationId)}
                      >
                        <RefreshCw className={cn("h-3.5 w-3.5", runNow.isPending && runNow.variables === w.organizationId && "animate-spin")} />
                        <span className="sr-only sm:not-sr-only">Back up now</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </ConsoleTable>
      </ConsoleSection>

      <DestinationsTab overview={d} />

      <ConsoleSection title="Recent runs" description="Every scheduled, manual, pre-deletion and test-restore run. A checksum is stored with each backup so a restore can prove it read back what was written." flush>
        {d.recentRuns.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState icon={Database} title="Nothing has run yet" description="Configure a schedule, or press “Back up now” on a workspace." />
          </div>
        ) : (
          <ConsoleTable minWidth={980} className="rounded-none border-x-0 border-b-0">
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.recentRuns.map((r: BackupRunRow) => {
                const workspace = d.workspaces.find((w) => w.organizationId === r.organizationId);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">{shortDateTime(r.startedAt)}</TableCell>
                    <TableCell className="max-w-[13rem] truncate text-sm">{r.organizationName}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{r.kind.toLowerCase().replace("_", " ")}</TableCell>
                    <TableCell className="max-w-[11rem] truncate text-xs text-muted-foreground">{r.destinationName ?? "—"}</TableCell>
                    <Num>{formatBytes(r.bytes)}</Num>
                    <TableCell>
                      <span className="flex flex-col gap-0.5">
                        <span className="flex items-center gap-1.5">
                          <Badge variant={RUN_VARIANT[r.status] ?? "muted"}>{r.status.toLowerCase()}</Badge>
                          {r.retentionTag && <Badge variant="muted">{r.retentionTag.toLowerCase()}</Badge>}
                        </span>
                        {r.errorMessage && <span className="line-clamp-2 max-w-[22rem] text-[11px] text-destructive">{r.errorMessage}</span>}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      {r.status === "SUCCEEDED" && r.objectKey && r.kind !== "TEST_RESTORE" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1.5"
                          disabled={!workspace?.entitlement.pitrEnabled || testRestore.isPending}
                          title={workspace?.entitlement.pitrEnabled ? "Restore into a scratch database, verify, then drop it." : `Test restores are an Enterprise capability; this workspace is on ${workspace?.entitlement.tier}.`}
                          onClick={() => testRestore.mutate(r.id)}
                        >
                          {testRestore.isPending && testRestore.variables === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                          <span className="sr-only sm:not-sr-only">Test restore</span>
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </ConsoleTable>
        )}
      </ConsoleSection>

      <ScheduleDialog overview={d} workspace={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
