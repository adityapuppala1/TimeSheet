/**
 * The three panels 4.0.0 adds to a workspace's monitoring page, kept out of `Monitoring.tsx` so
 * that file stays the one that composes the page rather than the one that draws everything on it.
 *
 *   `TrendPanel`     — the time dimension. A single measurement answers "how big is it"; almost
 *                      every question an operator actually has is a derivative of that.
 *   `SchemaPanel`    — the shape of the schema, plus the only two operations this console can run
 *                      against a customer's database, both of them guarded server-side.
 *   `AdvisorPanel`   — the AI reading of those numbers, with the human decision it requires.
 *
 * ONE RULE RUNS THROUGH ALL THREE: the console proposes, a person disposes. The advisor's findings
 * are proposals. `Reclaim space` refuses outside a maintenance window and says so. Nothing here
 * takes an action a human did not press.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Brain,
  CalendarClock,
  CheckCircle2,
  Gauge,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  TrendingUp,
  Wrench,
  XCircle
} from "lucide-react";
import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Legend, Line, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Progress } from "../../components/ui/progress";
import { Skeleton } from "../../components/ui/skeleton";
import { Textarea } from "../../components/ui/textarea";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { toast } from "../../components/ui/toaster";
import {
  platformOpsExtrasApi,
  type AdvisorFinding,
  type AdviceRow,
  type TenantDatabaseMetrics,
  type TenantTableRow
} from "../../services/platform-admin-api";
import { ConsoleSection, ConsoleTable, EmptyState, formatBytes, Num, PRIMARY_BTN, SegmentedControl, Toolbar, shortDateTime } from "./console-ui";

const errorMessageOf = (error: unknown) => (error as { response?: { data?: { message?: string } } })?.response?.data?.message;

const CHART_TOOLTIP = {
  background: "hsl(var(--popover))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 12,
  color: "hsl(var(--popover-foreground))"
};

function Figure({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "warn" | "bad" }) {
  const colour = tone === "bad" ? "text-destructive" : tone === "warn" ? "text-warning" : tone === "good" ? "text-success" : "text-foreground";
  return (
    <div className="grid min-w-0 grid-cols-1 gap-0.5 rounded-lg border border-border p-3">
      <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`truncate font-mono text-lg font-bold tabular-nums ${colour}`}>{value}</p>
      {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- */
/* Trend                                                                                        */
/* ------------------------------------------------------------------------------------------- */

const TREND_WINDOWS = ["7", "30", "90", "365"] as const;
type TrendWindow = (typeof TREND_WINDOWS)[number];

export function TrendPanel({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const [days, setDays] = useState<TrendWindow>("30");

  const { data, isLoading } = useQuery({
    queryKey: ["platform-admin", "db-trend", orgId, days],
    queryFn: () => platformOpsExtrasApi.trend(orgId, Number(days))
  });

  const sample = useMutation({
    mutationFn: platformOpsExtrasApi.sampleNow,
    onSuccess: (result) => {
      toast.success(`${result.sampled} workspace${result.sampled === 1 ? "" : "s"} sampled`, {
        description: result.failed.length ? `${result.failed.length} unreachable: ${result.failed.map((f) => f.slug).join(", ")}` : "Every database answered."
      });
      void queryClient.invalidateQueries({ queryKey: ["platform-admin", "db-trend"] });
    },
    onError: (error) => toast.error("Could not sample", { description: errorMessageOf(error) })
  });

  const points = useMemo(
    () =>
      (data?.points ?? []).map((point) => ({
        at: new Date(point.at).toLocaleDateString(undefined, { day: "numeric", month: "short" }),
        dataMb: Math.round((point.dataBytes / 1024 / 1024) * 10) / 10,
        indexMb: Math.round((point.indexBytes / 1024 / 1024) * 10) / 10,
        freeMb: Math.round((point.freeBytes / 1024 / 1024) * 10) / 10,
        rows: point.estimatedRows,
        probeMs: point.queryMs
      })),
    [data]
  );

  const growth = data?.growth;

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <ConsoleSection
        title="Growth"
        description="Sampled hourly and kept for a bit over a year, so a capacity conversation can start with what actually happened rather than what somebody remembers."
        actions={
          <Toolbar>
            <SegmentedControl<TrendWindow> ariaLabel="Trend window" value={days} onChange={setDays} options={TREND_WINDOWS.map((value) => ({ value, label: value === "365" ? "1 year" : `${value} days` }))} />
            <Button variant="outline" size="sm" className="gap-1.5" disabled={sample.isPending} onClick={() => sample.mutate()}>
              {sample.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Sample now
            </Button>
          </Toolbar>
        }
      >
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : points.length < 2 ? (
          <EmptyState
            icon={TrendingUp}
            title={points.length === 0 ? "No samples yet" : "One sample so far"}
            description="Readings are taken every hour, five past the half. Take one now if you would rather not wait — an empty chart on a fresh install looks exactly like a broken one, which is why the button is here."
            action={
              <Button variant="outline" size="sm" className="gap-1.5" disabled={sample.isPending} onClick={() => sample.mutate()}>
                <RefreshCw className="h-4 w-4" />
                Sample now
              </Button>
            }
          />
        ) : (
          <>
            <div className="h-64 w-full min-w-0 sm:h-72">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="dataFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--accent))" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="hsl(var(--accent))" stopOpacity={0.05} />
                    </linearGradient>
                    <linearGradient id="indexFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--info))" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="hsl(var(--info))" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="at" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} minTickGap={24} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={48} />
                  <RTooltip contentStyle={CHART_TOOLTIP} formatter={(value: number, key) => [`${value} MB`, String(key)]} />
                  <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" />
                  {/* Stacked, because data and index together ARE the database — showing them as
                      two independent lines invites reading the total off the taller one. */}
                  <Area type="monotone" dataKey="dataMb" name="Data" stackId="size" stroke="hsl(var(--accent))" fill="url(#dataFill)" strokeWidth={2} />
                  <Area type="monotone" dataKey="indexMb" name="Index" stackId="size" stroke="hsl(var(--info))" fill="url(#indexFill)" strokeWidth={2} />
                  <Line type="monotone" dataKey="freeMb" name="Free (reclaimable)" stroke="hsl(var(--warning))" strokeDasharray="4 3" dot={false} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-4 grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">
              <Figure
                label="Change"
                value={growth?.percentChange === null || growth?.percentChange === undefined ? "—" : `${growth.percentChange > 0 ? "+" : ""}${growth.percentChange.toFixed(1)}%`}
                hint={`over ${growth?.samples ?? 0} samples`}
                tone={(growth?.percentChange ?? 0) > 25 ? "warn" : undefined}
              />
              <Figure label="Rate" value={growth?.bytesPerDay === null || growth?.bytesPerDay === undefined ? "—" : `${formatBytes(growth.bytesPerDay)}/day`} hint="first to last sample" />
              <Figure label="Rows added" value={growth?.rowsPerDay === null || growth?.rowsPerDay === undefined ? "—" : `${Math.round(growth.rowsPerDay).toLocaleString()}/day`} hint="InnoDB estimate" />
              <Figure
                label={`Reaches ${formatBytes(growth?.projectionTargetBytes)}`}
                value={growth?.daysToTarget === null || growth?.daysToTarget === undefined ? "—" : `${Math.round(growth.daysToTarget)} days`}
                hint={growth?.daysToTarget === null ? "flat or shrinking" : "at the current rate"}
                tone={(growth?.daysToTarget ?? Infinity) < 90 ? "warn" : undefined}
              />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              The rate is measured from the first and last sample in the window rather than fitted — a least-squares slope across a series with one migration-shaped step in it
              reports a confident number that describes nothing. Anything under a day of span refuses to extrapolate at all.
            </p>
          </>
        )}
      </ConsoleSection>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- */
/* Schema and the two operations                                                                */
/* ------------------------------------------------------------------------------------------- */

function OperationDialog({
  orgId,
  operation,
  tables,
  onClose
}: {
  orgId: string;
  operation: "ANALYZE" | "OPTIMIZE";
  tables: string[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: () => platformOpsExtrasApi.runOperation(orgId, operation, tables),
    onSuccess: (result) => {
      const errors = result.messages.filter((message) => message.type.toLowerCase() === "error");
      toast[errors.length ? "warning" : "success"](
        operation === "ANALYZE" ? "Statistics refreshed" : `Space reclaimed${result.freedBytes ? `: ${formatBytes(result.freedBytes)}` : ""}`,
        { description: `${result.tables.length} table${result.tables.length === 1 ? "" : "s"} in ${(result.ms / 1000).toFixed(1)}s${errors.length ? ` · ${errors.length} reported an error` : ""}` }
      );
      onClose();
      void queryClient.invalidateQueries({ queryKey: ["platform-admin"] });
    },
    onError: (error) => toast.error("Not run", { description: errorMessageOf(error) })
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{operation === "ANALYZE" ? "Refresh table statistics" : "Reclaim fragmented space"}</DialogTitle>
          <DialogDescription>
            {operation === "ANALYZE" ? (
              <>
                Runs <span className="font-mono text-xs">ANALYZE TABLE</span> across {tables.length ? `${tables.length} selected table${tables.length === 1 ? "" : "s"}` : "every table in the schema"}. It
                is online and cheap: it recomputes the optimiser's statistics so a query plan that drifted as the data changed shape is corrected. Nothing is rewritten and
                nothing is locked.
              </>
            ) : (
              <>
                Runs <span className="font-mono text-xs">OPTIMIZE TABLE</span> across {tables.length ? `${tables.length} selected table${tables.length === 1 ? "" : "s"}` : "every table in the schema"}. On
                InnoDB this <strong>rebuilds each table and blocks writes to it while it runs</strong> — minutes on a large one, with every request touching it waiting. It is
                refused unless this workspace is inside an active maintenance window.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button className={PRIMARY_BTN} disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Running…
              </>
            ) : (
              <>
                <Play className="mr-2 h-4 w-4" />
                Run it
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A table's fragmentation as a bar, so a column of percentages reads as a shape. */
function FragmentationCell({ table }: { table: TenantTableRow }) {
  const percent = (table.fragmentation ?? 0) * 100;
  return (
    <TableCell className="min-w-[8rem]">
      <p className="font-mono text-xs tabular-nums text-foreground">
        {percent.toFixed(0)}% <span className="text-muted-foreground">({formatBytes(table.freeBytes)})</span>
      </p>
      <Progress value={Math.min(100, percent)} className="mt-1 h-1.5" indicatorClassName={percent >= 30 ? "bg-warning" : "bg-muted-foreground/40"} />
    </TableCell>
  );
}

export function SchemaPanel({ orgId, metrics }: { orgId: string; metrics: TenantDatabaseMetrics }) {
  const [pending, setPending] = useState<{ operation: "ANALYZE" | "OPTIMIZE"; tables: string[] } | null>(null);

  const fragmented = metrics.schema.largestTables.filter((table) => (table.fragmentation ?? 0) >= 0.3 && table.freeBytes > 50 * 1024 ** 2);
  /*
   * The key-headroom column earns its place only in a schema that HAS integer keys. TimeSphere's
   * own tables are all UUID-keyed, so on this product it would be a column of dashes on every row —
   * and a column that never says anything teaches a reader to skip the ones next to it. It stays in
   * the payload and in the alerts, because a workspace restored from somebody else's dump, or a
   * future table with a BIGINT key, is exactly when it matters.
   */
  const showKeyHeadroom = metrics.schema.largestTables.some((table) => table.autoIncrementUsePercent !== null);

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <ConsoleSection
        title="Schema shape"
        description="What the database is made of, and the parts of that a rebuild or an index would change."
        actions={
          <Toolbar>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setPending({ operation: "ANALYZE", tables: [] })}>
              <Gauge className="h-4 w-4" />
              Refresh statistics
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setPending({ operation: "OPTIMIZE", tables: fragmented.map((table) => table.name) })}
              disabled={fragmented.length === 0}
              title={fragmented.length === 0 ? "Nothing is fragmented enough to be worth a rebuild." : undefined}
            >
              <Wrench className="h-4 w-4" />
              Reclaim {fragmented.length > 0 ? formatBytes(fragmented.reduce((sum, table) => sum + table.freeBytes, 0)) : "space"}
            </Button>
          </Toolbar>
        }
      >
        <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">
          <Figure label="Reclaimable" value={formatBytes(metrics.schema.freeBytes)} hint="allocated and unused" tone={metrics.schema.freeBytes > 1024 ** 3 ? "warn" : undefined} />
          <Figure label="Indexes" value={metrics.schema.indexCount.toLocaleString()} hint={`across ${metrics.schema.tableCount} tables`} />
          <Figure
            label="Without a primary key"
            value={String(metrics.schema.tablesWithoutPrimaryKey.length)}
            hint={metrics.schema.tablesWithoutPrimaryKey.slice(0, 2).join(", ") || "none"}
            tone={metrics.schema.tablesWithoutPrimaryKey.length ? "warn" : "good"}
          />
          <Figure label="Engines" value={metrics.schema.engines.map((engine) => engine.engine).join(", ") || "—"} hint={metrics.schema.engines.map((engine) => `${engine.engine} ${engine.tables}`).join(" · ")} />
        </div>

        <div className="mt-4">
          <ConsoleTable minWidth={960}>
            <TableHeader>
              <TableRow>
                <TableHead>Table</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead className="text-right">Avg row</TableHead>
                <TableHead className="text-right">Indexes</TableHead>
                <TableHead>Fragmentation</TableHead>
                {showKeyHeadroom && <TableHead>Key headroom</TableHead>}
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {metrics.schema.largestTables.map((table) => (
                <TableRow key={table.name}>
                  <TableCell className="min-w-0">
                    <p className="truncate font-mono text-xs font-medium text-foreground">{table.name}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {table.engine ?? "—"}
                      {table.hasPrimaryKey ? "" : " · no primary key"}
                    </p>
                  </TableCell>
                  <Num>{formatBytes(table.totalBytes)}</Num>
                  <Num>{table.estimatedRows.toLocaleString()}</Num>
                  <Num>{formatBytes(table.avgRowBytes)}</Num>
                  <Num>{table.indexCount}</Num>
                  <FragmentationCell table={table} />
                  {showKeyHeadroom && (
                    <TableCell className="min-w-[7rem]">
                      {table.autoIncrementUsePercent === null ? (
                        <span className="text-xs text-muted-foreground" title="This table has no integer auto-increment key.">
                          n/a
                        </span>
                      ) : (
                        <>
                          <p className="font-mono text-xs tabular-nums text-foreground">{table.autoIncrementUsePercent.toFixed(1)}%</p>
                          <Progress
                            value={Math.min(100, table.autoIncrementUsePercent)}
                            className="mt-1 h-1.5"
                            indicatorClassName={table.autoIncrementUsePercent >= 90 ? "bg-destructive" : table.autoIncrementUsePercent >= 70 ? "bg-warning" : "bg-success"}
                          />
                        </>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => setPending({ operation: "ANALYZE", tables: [table.name] })}>
                      Analyze
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ConsoleTable>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Row counts and average row size are InnoDB estimates.{" "}
          {showKeyHeadroom && (
            <>
              <span className="font-semibold">Key headroom</span> is how much of a signed <span className="font-mono">INT</span> auto-increment has been consumed — at 100% every
              insert into that table fails, and widening the column is a full rebuild that wants planning rather than an outage.{" "}
            </>
          )}
          <span className="font-semibold">Reclaim</span> is offered only where at least 50 MB is actually held by fragmentation: rebuilding a small table costs a lock and returns
          nothing worth having.
        </p>
      </ConsoleSection>

      {metrics.activeQueries.length > 0 && (
        <ConsoleSection
          title="Running right now"
          description="Statements against this schema, reduced to their shape — every literal is stripped before it leaves the API, because a workspace's SQL carries a workspace's data."
          flush
        >
          <ConsoleTable minWidth={720}>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">Seconds</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Statement shape</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {metrics.activeQueries.map((query) => (
                <TableRow key={query.id}>
                  <Num className={query.seconds >= 60 ? "text-destructive" : query.seconds >= 10 ? "text-warning" : undefined}>{query.seconds}</Num>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{query.state ?? query.command}</TableCell>
                  <TableCell className="min-w-0">
                    <p className="truncate font-mono text-[11px] text-foreground" title={query.digest ?? undefined}>
                      {query.digest ?? "—"}
                    </p>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ConsoleTable>
        </ConsoleSection>
      )}

      {metrics.schema.widestIndexes.length > 0 && (
        <ConsoleSection title="Widest indexes" description="Composite indexes cost on every write. The widest are worth knowing about; whether they earn their keep is a question for the schema's owners." flush>
          <ConsoleTable minWidth={760}>
            <TableHeader>
              <TableRow>
                <TableHead>Index</TableHead>
                <TableHead>Table</TableHead>
                <TableHead>Columns</TableHead>
                <TableHead className="text-right">Cardinality</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {metrics.schema.widestIndexes.map((index) => (
                <TableRow key={`${index.table}.${index.name}`}>
                  <TableCell className="min-w-0">
                    <p className="truncate font-mono text-xs text-foreground">{index.name}</p>
                    {index.unique && <Badge variant="info">unique</Badge>}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{index.table}</TableCell>
                  <TableCell className="min-w-0">
                    <p className="truncate font-mono text-[11px] text-muted-foreground">{index.columns.join(", ")}</p>
                  </TableCell>
                  <Num>{index.cardinality.toLocaleString()}</Num>
                </TableRow>
              ))}
            </TableBody>
          </ConsoleTable>
        </ConsoleSection>
      )}

      {pending && <OperationDialog orgId={orgId} operation={pending.operation} tables={pending.tables} onClose={() => setPending(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- */
/* The advisor                                                                                  */
/* ------------------------------------------------------------------------------------------- */

const SEVERITY_BADGE: Record<AdvisorFinding["severity"], "destructive" | "warning" | "info"> = {
  critical: "destructive",
  warning: "warning",
  info: "info"
};

const CONFIDENCE_LABEL: Record<AdvisorFinding["confidence"], string> = {
  high: "confident",
  medium: "fairly sure",
  low: "thin evidence"
};

function FindingCard({ finding, onRun }: { finding: AdvisorFinding; onRun: (operation: "ANALYZE" | "OPTIMIZE", tables: string[]) => void }) {
  const executable = finding.action === "ANALYZE_TABLES" || finding.action === "OPTIMIZE_TABLES";
  return (
    <div className="grid min-w-0 grid-cols-1 gap-2 rounded-lg border border-border p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant={SEVERITY_BADGE[finding.severity]} className="uppercase">
          {finding.severity}
        </Badge>
        <p className="min-w-0 flex-1 text-sm font-semibold text-foreground">{finding.title}</p>
        {/* A hedge is information: an operator reads a low-confidence finding differently, and
            hiding the model's own uncertainty is how a guess becomes a fact. */}
        <Badge variant="muted">{CONFIDENCE_LABEL[finding.confidence]}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{finding.rationale}</p>
      {finding.tables.length > 0 && (
        <p className="flex flex-wrap gap-1">
          {finding.tables.map((table) => (
            <span key={table} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {table}
            </span>
          ))}
        </p>
      )}
      {executable && (
        <div>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onRun(finding.action === "ANALYZE_TABLES" ? "ANALYZE" : "OPTIMIZE", finding.tables)}>
            <Play className="h-3.5 w-3.5" />
            {finding.action === "ANALYZE_TABLES" ? "Refresh statistics" : "Reclaim space"}
          </Button>
        </div>
      )}
    </div>
  );
}

function DecisionDialog({ advice, onClose }: { advice: AdviceRow; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const decide = useMutation({
    mutationFn: (status: "APPLIED" | "DISMISSED") => platformOpsExtrasApi.decideAdvice(advice.id, status, note || null),
    onSuccess: () => {
      toast.success("Recorded");
      onClose();
      void queryClient.invalidateQueries({ queryKey: ["platform-admin", "advice"] });
    },
    onError: (error) => toast.error("Not recorded", { description: errorMessageOf(error) })
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close this advisory</DialogTitle>
          <DialogDescription>
            Say what happened. A dismissal needs a reason — it is the only record of the advisor being wrong, and an advisor whose failures are not written down cannot be
            evaluated, only believed.
          </DialogDescription>
        </DialogHeader>
        <Textarea rows={3} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Ran the analyze; p95 on the approvals endpoint halved. / Wrong — that table is append-only, fragmentation is expected." />
        <DialogFooter>
          <Button variant="outline" className="gap-1.5" disabled={decide.isPending || !note.trim()} onClick={() => decide.mutate("DISMISSED")}>
            <ThumbsDown className="h-4 w-4" />
            Dismiss
          </Button>
          <Button className={`${PRIMARY_BTN} gap-1.5`} disabled={decide.isPending} onClick={() => decide.mutate("APPLIED")}>
            <ThumbsUp className="h-4 w-4" />
            Acted on it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdvisorPanel({ orgId, days }: { orgId: string; days: number }) {
  const queryClient = useQueryClient();
  const [deciding, setDeciding] = useState<AdviceRow | null>(null);
  const [pending, setPending] = useState<{ operation: "ANALYZE" | "OPTIMIZE"; tables: string[] } | null>(null);

  const settings = useQuery({ queryKey: ["platform-admin", "ai-settings"], queryFn: platformOpsExtrasApi.aiSettings });
  const history = useQuery({ queryKey: ["platform-admin", "advice", orgId], queryFn: () => platformOpsExtrasApi.advice(orgId) });

  const generate = useMutation({
    mutationFn: () => platformOpsExtrasApi.advise(orgId, days),
    onSuccess: (result) => {
      toast.success(result.findings.length ? `${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}` : "Nothing worth flagging", {
        description: result.findings.length ? undefined : "The advisor looked and had nothing to say, which is a legitimate answer."
      });
      void queryClient.invalidateQueries({ queryKey: ["platform-admin", "advice", orgId] });
      void queryClient.invalidateQueries({ queryKey: ["platform-admin", "ai-settings"] });
    },
    onError: (error) => toast.error("No advice", { description: errorMessageOf(error) })
  });

  const configured = settings.data?.settings.enabled;
  const latest = history.data?.advice[0];

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <ConsoleSection
        title="AI advisor"
        description="It reads the same aggregate metrics this page shows — sizes, rates, alerts, statement shapes — and ranks what is worth doing. It sees no customer data, it runs nothing on its own, and every finding it makes is a proposal you accept or reject in writing."
        actions={
          <Toolbar>
            {settings.data && (
              <Badge variant="muted" className="gap-1.5">
                <Sparkles className="h-3 w-3" />
                {settings.data.settings.usedToday}/{settings.data.settings.dailyCallLimit} today
              </Badge>
            )}
            <Button className={`${PRIMARY_BTN} gap-1.5`} disabled={!configured || generate.isPending} onClick={() => generate.mutate()}>
              {generate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Brain className="h-4 w-4" />}
              {generate.isPending ? "Reading the numbers…" : "Ask the advisor"}
            </Button>
          </Toolbar>
        }
      >
        {settings.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !configured ? (
          <EmptyState
            icon={Brain}
            title="The advisor is switched off"
            description="It needs a provider and a key of its own — the platform's, never a workspace's. A self-hosted OpenAI-compatible endpoint works, if fleet metrics should not leave the building. Set it up under Settings → AI advisor."
          />
        ) : !latest ? (
          <EmptyState icon={Brain} title="No advice yet" description="Ask the advisor to read this workspace's numbers. It is never triggered automatically — an advisor that runs on a timer produces a queue nobody reads and a bill somebody pays." />
        ) : (
          <div className="grid min-w-0 grid-cols-1 gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" />
              {shortDateTime(latest.createdAt)}
              <span aria-hidden>·</span>
              <span className="font-mono">{latest.model}</span>
              <span aria-hidden>·</span>
              {latest.inputTokens.toLocaleString()} in / {latest.outputTokens.toLocaleString()} out
              <Badge variant={latest.status === "PENDING" ? "warning" : latest.status === "APPLIED" ? "success" : "muted"}>{latest.status.toLowerCase()}</Badge>
            </div>

            {latest.summary && <p className="rounded-lg border-l-4 border-accent bg-accent/5 px-4 py-3 text-sm text-foreground">{latest.summary}</p>}

            {(latest.findings ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No findings — the advisor read the numbers and had nothing to add to the thresholds already on this page.</p>
            ) : (
              (latest.findings ?? []).map((finding, index) => (
                <FindingCard key={`${finding.action}-${index}`} finding={finding} onRun={(operation, tables) => setPending({ operation, tables })} />
              ))
            )}

            {latest.status === "PENDING" && (
              <div>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setDeciding(latest)}>
                  <CheckCircle2 className="h-4 w-4" />
                  Close this advisory
                </Button>
              </div>
            )}
            {latest.decisionNote && (
              <p className="text-xs text-muted-foreground">
                <span className="font-semibold">{latest.decidedBy}</span>: {latest.decisionNote}
              </p>
            )}
          </div>
        )}
      </ConsoleSection>

      {(history.data?.advice.length ?? 0) > 1 && (
        <ConsoleSection title="Earlier advisories" description="Kept whether or not anybody acted on them — including the wrong ones, which are the only way to tell whether the advisor is any good." flush>
          <ConsoleTable minWidth={780}>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead className="text-right">Findings</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(history.data?.advice ?? []).slice(1).map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{shortDateTime(row.createdAt)}</TableCell>
                  <TableCell className="max-w-[26rem]">
                    <p className="truncate text-sm text-foreground">{row.summary || "—"}</p>
                    {row.decisionNote && <p className="truncate text-xs text-muted-foreground">{row.decisionNote}</p>}
                  </TableCell>
                  <Num>{row.findings?.length ?? 0}</Num>
                  <TableCell>
                    <Badge variant={row.status === "PENDING" ? "warning" : row.status === "APPLIED" ? "success" : "muted"} className="gap-1">
                      {row.status === "APPLIED" ? <CheckCircle2 className="h-3 w-3" /> : row.status === "DISMISSED" ? <XCircle className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                      {row.status.toLowerCase()}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ConsoleTable>
        </ConsoleSection>
      )}

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          What the advisor is shown: aggregate sizes, counts, rates, the thresholds already crossed, and statement <em>shapes</em> with every literal stripped. What it is never
          shown: a row, a column value, a name, an address, or anything a workspace's own administrator typed. That boundary is one function, and a test plants identifying
          strings in the input and fails if any of them reach the model.
        </span>
      </p>

      {deciding && <DecisionDialog advice={deciding} onClose={() => setDeciding(null)} />}
      {pending && <OperationDialog orgId={orgId} operation={pending.operation} tables={pending.tables} onClose={() => setPending(null)} />}
    </div>
  );
}
