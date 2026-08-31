/**
 * WHAT: what is wrong across the whole fleet right now, where those alerts go when nobody is
 * looking at this page, and which tenants are running behind the code that is deployed.
 *
 * WHY THE THREE ARE ON ONE SCREEN. They are the same question at three distances. The alert list is
 * "what is wrong"; the delivery card is "who finds out when I close this tab"; schema drift is the
 * one fleet-wide fault that produces no alert of its own until a worker starts throwing "table does
 * not exist" once a minute. An operator opening this page under pressure should not have to know
 * which of three pages holds the half they need.
 *
 * THE PAGE STATES THE ANTI-NOISE RULE, in the delivery card, in the same words the service uses.
 * That is not decoration: an operator who does not know the digest reports CHANGES will read a
 * quiet inbox as a broken worker and go looking for a bug that is not there. "Last run" and "last
 * sent" are shown as two separate facts for exactly the same reason.
 *
 * SCHEMA DRIFT HAS NO BUTTON, and says so on the page. The fix is a fan-out that opens, migrates and
 * closes every tenant database in turn and can fail on any one of them; that wants a terminal with
 * somebody watching, not a browser tab that times out at thirty seconds and leaves half the fleet
 * moved. The exact command is printed instead, ready to copy.
 *
 * Anatomy, kit and query keys are the console's standard — see `console-ui.tsx`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BellRing, CheckCircle2, Database, Download, Info, Send, ServerCrash, Siren, Webhook } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/utils";
import { platformAlertsApi, type AlertSeverity, type FleetAlert } from "../../services/platform-admin-api";
import { exportCsv, type CsvColumn } from "../../utils/console-csv";
import {
  ConsolePage,
  ConsoleSection,
  ConsoleTable,
  EmptyState,
  Field,
  FieldGrid,
  KpiCard,
  KpiGrid,
  PRIMARY_BTN,
  SegmentedControl,
  SwitchField,
  Toolbar,
  shortDateTime
} from "./console-ui";

const errorMessageOf = (error: unknown) => (error as { response?: { data?: { message?: string } } })?.response?.data?.message;

const SEVERITY_VARIANT: Record<AlertSeverity, "destructive" | "warning" | "info"> = {
  critical: "destructive",
  warning: "warning",
  info: "info"
};

/** The export mirrors the table, plus the two facts the table shows as relative time. A spreadsheet
 *  has no "3 days ago"; it needs the timestamp. */
const ALERT_CSV_COLUMNS = (openBy: Map<string, { firstSeenAt: string; lastReportedAt: string | null }>): Array<CsvColumn<FleetAlert>> => [
  { header: "Severity", value: (alert) => alert.severity },
  { header: "Workspace", value: (alert) => alert.name },
  { header: "Slug", value: (alert) => alert.slug },
  { header: "Area", value: (alert) => alert.area },
  { header: "Alert", value: (alert) => alert.title },
  { header: "Detail", value: (alert) => alert.detail },
  { header: "Condition key", value: (alert) => alert.key },
  { header: "Open since", value: (alert) => openBy.get(`${alert.organizationId}::${alert.key}`)?.firstSeenAt ?? "" },
  { header: "Last reported", value: (alert) => openBy.get(`${alert.organizationId}::${alert.key}`)?.lastReportedAt ?? "" }
];

export function PlatformAdminAlerts() {
  const queryClient = useQueryClient();
  const alerts = useQuery({ queryKey: ["platform-admin", "alerts"], queryFn: platformAlertsApi.overview });
  const drift = useQuery({ queryKey: ["platform-admin", "schema-drift"], queryFn: platformAlertsApi.schemaDrift });
  const [severity, setSeverity] = useState<AlertSeverity | "all">("all");

  const sweep = alerts.data?.sweep;
  const openBy = new Map((alerts.data?.open ?? []).map((row) => [`${row.organizationId}::${row.alertKey}`, row]));
  // What the SEGMENTED CONTROL matched — this is what the table renders and what the CSV exports,
  // so the file and the screen cannot disagree.
  const shown = (sweep?.alerts ?? []).filter((alert) => severity === "all" || alert.severity === severity);

  return (
    <ConsolePage
      eyebrow="Operations"
      title="Fleet alerts"
      description="Every workspace's alerts in one list, the digest that carries them to people who are not looking at this page, and which tenants are behind the running code."
      actions={
        <Button size="sm" className={PRIMARY_BTN} onClick={() => alerts.refetch()} disabled={alerts.isFetching}>
          {alerts.isFetching ? "Sweeping…" : "Sweep now"}
        </Button>
      }
    >
      {alerts.isLoading && (
        <KpiGrid>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[6.5rem] w-full rounded-xl" />
          ))}
        </KpiGrid>
      )}

      {sweep && (
        <KpiGrid>
          <KpiCard icon={Siren} label="Critical" value={sweep.totals.critical} tone={sweep.totals.critical > 0 ? "destructive" : "success"} />
          <KpiCard icon={AlertTriangle} label="Warning" value={sweep.totals.warning} tone={sweep.totals.warning > 0 ? "warning" : "default"} delay={0.05} />
          <KpiCard icon={Info} label="Informational" value={sweep.totals.info} delay={0.1} />
          <KpiCard
            icon={ServerCrash}
            label="Workspaces affected"
            value={sweep.totals.workspaces}
            tone={sweep.totals.workspaces > 0 ? "warning" : "success"}
            hint={sweep.unreachable.length ? `${sweep.unreachable.length} could not be read at all` : `Swept ${shortDateTime(sweep.generatedAt)}`}
            delay={0.15}
          />
        </KpiGrid>
      )}

      {/* An unreachable workspace produces NO alerts, which on a list is indistinguishable from a
          healthy one. Called out above the table rather than folded into it for that reason. */}
      {sweep && sweep.unreachable.length > 0 && (
        <ConsoleSection title="Could not be read" description="These workspaces produced no alerts because nothing could be measured — which is not the same as nothing being wrong." flush>
          <ConsoleTable minWidth={620}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Workspace</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sweep.unreachable.map((row) => (
                <TableRow key={row.organizationId}>
                  <TableCell className="whitespace-nowrap">
                    <Link to={`/platform-admin/organizations/${row.organizationId}`} className="focus-ring rounded font-medium text-accent hover:underline">
                      {row.name}
                    </Link>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{row.slug}</span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.error}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ConsoleTable>
        </ConsoleSection>
      )}

      <ConsoleSection
        title="What is wrong right now"
        description="Derived from each workspace's own numbers. Every threshold is stated in the alert, so nothing here is a black box."
        actions={
          sweep && sweep.alerts.length > 0 ? (
            <Toolbar>
              <SegmentedControl
                ariaLabel="Filter by severity"
                value={severity}
                onChange={setSeverity}
                options={[
                  { value: "all" as const, label: "All", count: sweep.alerts.length },
                  { value: "critical" as const, label: "Critical", count: sweep.totals.critical },
                  { value: "warning" as const, label: "Warning", count: sweep.totals.warning },
                  { value: "info" as const, label: "Info", count: sweep.totals.info }
                ]}
              />
              {/* `shown`, not `sweep.alerts`: the export carries the severity the operator selected. */}
              <Button variant="outline" size="sm" className="gap-2" disabled={shown.length === 0} onClick={() => exportCsv("fleet-alerts", ALERT_CSV_COLUMNS(openBy), shown)}>
                <Download className="h-4 w-4" />
                Export CSV
              </Button>
            </Toolbar>
          ) : undefined
        }
        flush={shown.length > 0}
      >
        {alerts.isLoading && <Skeleton className="h-48 w-full rounded-lg" />}
        {!alerts.isLoading && shown.length === 0 && (
          <EmptyState
            icon={CheckCircle2}
            title={sweep?.alerts.length ? "Nothing at this severity" : "The fleet is quiet."}
            description={sweep?.alerts.length ? "Every alert is at another severity." : "No workspace is reporting anything worth an operator's attention."}
          />
        )}
        {shown.length > 0 && (
          <ConsoleTable minWidth={980} className="rounded-none border-x-0 border-b-0">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="whitespace-nowrap">Severity</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead>Alert</TableHead>
                <TableHead className="whitespace-nowrap">Open since</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((alert) => {
                const state = openBy.get(`${alert.organizationId}::${alert.key}`);
                return (
                  <TableRow key={`${alert.organizationId}-${alert.key}`}>
                    <TableCell className="whitespace-nowrap align-top">
                      <Badge variant={SEVERITY_VARIANT[alert.severity]}>{alert.severity}</Badge>
                    </TableCell>
                    <TableCell className="align-top">
                      <Link to={`/platform-admin/organizations/${alert.organizationId}`} className="focus-ring rounded font-medium text-accent hover:underline">
                        {alert.name}
                      </Link>
                      <span className="block font-mono text-[11px] text-muted-foreground">{alert.slug}</span>
                    </TableCell>
                    <TableCell className="align-top">
                      <span className="block font-medium text-foreground">{alert.title}</span>
                      <span className="block text-xs text-muted-foreground">{alert.detail}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap align-top text-xs text-muted-foreground">
                      {state ? shortDateTime(state.firstSeenAt) : "—"}
                      {/* "Not reported yet" is a real and temporary state: the condition was seen by
                          a sweep but the digest has not run since, or could not deliver. Saying so
                          is what keeps "the alerting is broken" from being a guess. */}
                      <span className="block">{state?.lastReportedAt ? `reported ${shortDateTime(state.lastReportedAt)}` : "not reported yet"}</span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </ConsoleTable>
        )}
      </ConsoleSection>

      <DeliveryCard onSaved={() => queryClient.invalidateQueries({ queryKey: ["platform-admin", "alerts"] })} />

      <ConsoleSection
        title="Fleet schema drift"
        description="Which tenants are on which migration. A workspace behind the running code fails on every feature whose tables are missing, and nothing in the product says so to its users."
        flush
      >
        {drift.isLoading && <div className="p-4 sm:p-5"><Skeleton className="h-40 w-full rounded-lg" /></div>}
        {drift.data && (
          <>
            <div className="border-b border-border p-4 text-sm sm:p-5">
              <p className="flex flex-wrap items-center gap-2">
                <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span>
                  This build expects <span className="font-mono text-xs">{drift.data.latest}</span>.
                </span>
                {drift.data.behind === 0 ? (
                  <Badge variant="success">Fleet in step</Badge>
                ) : (
                  <Badge variant="destructive">
                    {drift.data.behind} behind
                  </Badge>
                )}
                {drift.data.unregistered > 0 && <Badge variant="muted">{drift.data.unregistered} with no database yet</Badge>}
              </p>
              {drift.data.behind > 0 && (
                <div className="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-3">
                  <p className="text-sm text-foreground">
                    There is deliberately <strong>no button</strong> for this. The fix opens, migrates and closes every tenant database in turn and can fail on any one of them — that needs a terminal
                    and somebody watching the output, not a browser tab that times out half way through the fleet. Run it from the repository root:
                  </p>
                  <code className="mt-2 block overflow-x-auto rounded border border-border bg-background px-3 py-2 font-mono text-xs">{drift.data.command}</code>
                </div>
              )}
            </div>
            <ConsoleTable minWidth={860} className="rounded-none border-x-0 border-b-0">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Workspace</TableHead>
                  <TableHead>Database</TableHead>
                  <TableHead>Schema version</TableHead>
                  <TableHead className="whitespace-nowrap">Last migrated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drift.data.rows.map((row) => (
                  <TableRow key={row.organizationId} className={cn(row.behind && "bg-destructive/5")}>
                    <TableCell className="whitespace-nowrap">
                      <Link to={`/platform-admin/organizations/${row.organizationId}`} className="focus-ring rounded font-medium text-accent hover:underline">
                        {row.name}
                      </Link>
                      <span className="ml-2 font-mono text-[11px] text-muted-foreground">{row.slug}</span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{row.databaseName ?? "Not provisioned"}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.schemaVersion ?? <span className="text-muted-foreground">never migrated</span>}
                      {row.behind && (
                        <Badge variant="destructive" className="ml-2">
                          behind
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{row.migratedAt ? shortDateTime(row.migratedAt) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ConsoleTable>
          </>
        )}
      </ConsoleSection>
    </ConsolePage>
  );
}

/**
 * Where the alerts go, and proof that they can get there.
 *
 * Both "test" actions exist because the alternative is finding out whether the alerting pipeline
 * works at the moment something breaks — which is how a pipeline turns out to have been broken for
 * a month. Preview is safe to press repeatedly: it sweeps and diffs and sends nothing, and records
 * nothing, so it cannot spend the one chance to report a condition.
 */
function DeliveryCard({ onSaved }: { onSaved: () => void }) {
  const alerts = useQuery({ queryKey: ["platform-admin", "alerts"], queryFn: platformAlertsApi.overview });
  const settings = alerts.data?.settings;

  const [form, setForm] = useState({ digestEnabled: true, minSeverity: "warning" as string, recipients: "", webhookUrl: "", webhookSecret: "" });
  const [loaded, setLoaded] = useState(false);

  // Seeded once, when the query first answers. Re-seeding on every render would fight the operator's
  // typing, and re-seeding on every refetch would discard an edit the moment the page polled.
  useEffect(() => {
    if (!settings || loaded) return;
    setForm({
      digestEnabled: settings.digestEnabled,
      minSeverity: settings.minSeverity,
      recipients: settings.recipients.join(", "),
      webhookUrl: settings.webhookUrl ?? "",
      webhookSecret: ""
    });
    setLoaded(true);
  }, [settings, loaded]);

  const save = useMutation({
    mutationFn: () =>
      platformAlertsApi.saveSettings({
        digestEnabled: form.digestEnabled,
        minSeverity: form.minSeverity,
        recipients: form.recipients
          .split(/[,\s]+/)
          .map((value) => value.trim())
          .filter(Boolean),
        webhookUrl: form.webhookUrl.trim() || null,
        // Omitted keeps the stored secret; the field is blank on load for exactly that reason, so
        // editing a URL never silently drops the signature.
        ...(form.webhookSecret ? { webhookSecret: form.webhookSecret } : {})
      }),
    onSuccess: () => {
      toast.success("Alert delivery saved");
      setForm((f) => ({ ...f, webhookSecret: "" }));
      onSaved();
    },
    onError: (error) => toast.error("Could not save", { description: errorMessageOf(error) })
  });

  const preview = useMutation({
    mutationFn: () => platformAlertsApi.runDigest(true),
    onSuccess: (result) =>
      toast.success(result.appeared + result.escalated + result.cleared > 0 ? `${result.appeared} new, ${result.escalated} escalated, ${result.cleared} cleared would go out` : "Nothing would be sent", {
        description: result.reason
      }),
    onError: (error) => toast.error("Could not preview", { description: errorMessageOf(error) })
  });

  const runNow = useMutation({
    mutationFn: () => platformAlertsApi.runDigest(false),
    onSuccess: (result) => {
      if (result.sent) toast.success(`Sent to ${result.mailed} of ${result.recipients} recipients`, { description: result.reason });
      else toast.info("Nothing was sent", { description: result.reason });
      onSaved();
    },
    onError: (error) => toast.error("Digest failed", { description: errorMessageOf(error) })
  });

  const testWebhook = useMutation({
    mutationFn: platformAlertsApi.testWebhook,
    onSuccess: (outcome) => {
      if (outcome.ok) toast.success("The endpoint accepted the test payload");
      else if (outcome.status === "not_configured") toast.info("No webhook is configured", { description: "Save a URL above, then test it." });
      else toast.error(`The endpoint answered ${outcome.status}`, { description: outcome.error });
      onSaved();
    },
    onError: (error) => toast.error("Could not reach the endpoint", { description: errorMessageOf(error) })
  });

  return (
    <ConsoleSection
      title="Where these alerts go"
      description="A scheduled operator digest, and an optional webhook for Slack or PagerDuty. Both carry the same event."
      actions={
        <Toolbar>
          <Button variant="outline" size="sm" onClick={() => preview.mutate()} disabled={preview.isPending}>
            {preview.isPending ? "Checking…" : "Preview"}
          </Button>
          <Button variant="outline" size="sm" className="gap-2" onClick={() => runNow.mutate()} disabled={runNow.isPending}>
            <Send className="h-4 w-4" />
            {runNow.isPending ? "Running…" : "Run digest now"}
          </Button>
          <Button size="sm" className={PRIMARY_BTN} onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </Toolbar>
      }
      bodyClassName="grid gap-5"
    >
      {/* THE RULE, on the page, in the service's own words. An operator who does not know the digest
          reports CHANGES will read a quiet inbox as a broken worker. */}
      <div className="flex flex-wrap items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
        <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          The digest sends only when something has <strong>changed</strong> — a new alert, one that got worse, or one that cleared. A standing alert is recorded and never repeated, because a message
          that arrives every morning saying the same thing is a message people filter. Silence means nothing changed, not that nothing is wrong.
        </span>
      </div>

      {settings && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Fact label="Last swept" value={settings.lastRunAt ? shortDateTime(settings.lastRunAt) : "Not yet"} />
          {/* Two facts, not one. "Quiet because nothing changed" and "quiet because the worker is
              dead" are different problems and must not look the same. */}
          <Fact label="Last message sent" value={settings.lastSentAt ? shortDateTime(settings.lastSentAt) : "Nothing has needed sending"} />
          <Fact label="Webhook" value={settings.webhookUrl ? (settings.lastWebhookStatus ?? "Configured, never used") : "Not configured"} />
        </div>
      )}

      <FieldGrid cols={2}>
        <SwitchField
          label="Scheduled digest"
          hint="Runs every six hours. Sends nothing unless something changed."
          checked={form.digestEnabled}
          onCheckedChange={(checked) => setForm((f) => ({ ...f, digestEnabled: checked }))}
          icon={BellRing}
        />
        <Field label="Report changes at or above" hint="Below this, a change is still recorded — it just does not become a message.">
          <SegmentedControl
            ariaLabel="Minimum severity"
            value={form.minSeverity}
            onChange={(value) => setForm((f) => ({ ...f, minSeverity: value }))}
            options={[
              { value: "critical", label: "Critical only" },
              { value: "warning", label: "Warning" },
              { value: "info", label: "Everything" }
            ]}
          />
        </Field>
      </FieldGrid>

      <Field
        label="Recipients"
        htmlFor="alert-recipients"
        hint="Comma separated. Leave empty to send to every active platform admin — which is the setting that keeps working when somebody leaves."
      >
        <Input
          id="alert-recipients"
          value={form.recipients}
          onChange={(event) => setForm((f) => ({ ...f, recipients: event.target.value }))}
          placeholder="ops@example.com, oncall@example.com"
        />
      </Field>

      <FieldGrid cols={2}>
        <Field label="Webhook URL" htmlFor="alert-webhook" hint="A Slack incoming webhook, a PagerDuty Events URL, anything that takes a POST. Empty means not configured.">
          <Input id="alert-webhook" value={form.webhookUrl} onChange={(event) => setForm((f) => ({ ...f, webhookUrl: event.target.value }))} placeholder="https://hooks.slack.com/services/…" />
        </Field>
        <Field
          label="Signing secret"
          htmlFor="alert-secret"
          hint={
            settings?.webhookSecretSet
              ? "A secret is stored. Leave blank to keep it; type a new one to replace it."
              : "Optional. When set, every delivery carries an X-TimeSphere-Signature header a receiver can verify."
          }
        >
          <Input
            id="alert-secret"
            type="password"
            autoComplete="new-password"
            value={form.webhookSecret}
            onChange={(event) => setForm((f) => ({ ...f, webhookSecret: event.target.value }))}
            placeholder={settings?.webhookSecretSet ? "••••••••" : "Leave empty for an unsigned POST"}
          />
        </Field>
      </FieldGrid>

      <Button variant="outline" size="sm" className="w-fit gap-2" onClick={() => testWebhook.mutate()} disabled={testWebhook.isPending}>
        <Webhook className="h-4 w-4" />
        {testWebhook.isPending ? "Posting…" : "Send a test payload"}
      </Button>
    </ConsoleSection>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border p-3">
      <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold text-foreground" title={value}>
        {value}
      </p>
    </div>
  );
}
