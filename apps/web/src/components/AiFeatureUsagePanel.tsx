/**
 * WHAT: per-feature AI token consumption — which feature spent what, cumulatively and day by day.
 *
 * WHY IT LEADS ON TOKENS RATHER THAN DOLLARS: the panel above this one already answers "what did
 * we spend this month", which is the number checked against a budget. This one is opened when that
 * number is higher than expected, and the actionable unit there is tokens. `costUsdEstimate` is an
 * estimate computed from a price table at call time — it shifts when a provider changes prices and
 * it is simply wrong for anyone on BYOK with negotiated rates, which makes it a poor basis for
 * comparing this month against last. Tokens are what was actually consumed and are what a prompt
 * change actually moves. Cost is still shown in the table, because the budget cap is denominated
 * in it.
 *
 * WHY A STACKED BAR FOR THE DAILY VIEW: the question is "did one feature's share change", and a
 * stack answers it directly — a band that widens is the culprit. Lines make the total hard to read
 * at a glance and cross each other into illegibility once there are more than about four features.
 * The trade is that a small band is hard to compare against another small band, which is what the
 * sortable table underneath is for. Neither view is sufficient alone, which is why both are here.
 *
 * The colour ramp is fixed and index-based, keyed off the server's `featureNames` order, so a
 * feature keeps its colour between the chart and the table.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis
} from "recharts";
import { ArrowDown, ArrowUp, Sparkles } from "lucide-react";

import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { settingsApi, type AIFeatureUsageRow } from "../services/api";
import { cn } from "../lib/utils";

/** Matches the palette the rest of the settings charts use. */
const SERIES_COLORS = [
  "hsl(var(--primary))",
  "hsl(var(--accent))",
  "hsl(var(--success))",
  "hsl(var(--warning))",
  "hsl(var(--info))",
  "hsl(var(--destructive))",
  "hsl(var(--muted-foreground))"
];

const GRID_STYLE = { strokeDasharray: "3 3", stroke: "hsl(var(--border))" } as const;
const AXIS_STYLE = { fill: "hsl(var(--muted-foreground))", fontSize: 11 } as const;
const TOOLTIP_STYLE = {
  contentStyle: {
    background: "hsl(var(--popover))",
    border: "1px solid hsl(var(--border))",
    borderRadius: "0.5rem",
    fontSize: "0.8rem"
  }
} as const;

/** `ai.ticket_triage` reads as machinery; "Ticket triage" reads as a feature. */
function prettyFeature(key: string): string {
  return key
    .replace(/^ai[._]/, "")
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

type SortKey = "feature" | "calls" | "inputTokens" | "outputTokens" | "totalTokens" | "avgTokensPerCall" | "costUsd";

const COLUMNS: Array<{ key: SortKey; label: string; numeric: boolean }> = [
  { key: "feature", label: "Feature", numeric: false },
  { key: "calls", label: "Calls", numeric: true },
  { key: "inputTokens", label: "Input", numeric: true },
  { key: "outputTokens", label: "Output", numeric: true },
  { key: "totalTokens", label: "Total tokens", numeric: true },
  { key: "avgTokensPerCall", label: "Avg / call", numeric: true },
  { key: "costUsd", label: "Est. cost", numeric: true }
];

const PAGE_SIZE = 8;

export function AiFeatureUsagePanel() {
  const [days, setDays] = useState(30);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("totalTokens");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  const usage = useQuery({
    queryKey: ["ai", "feature-usage", days],
    queryFn: () => settingsApi.getAIFeatureUsage(days)
  });

  const colorFor = useMemo(() => {
    const names = usage.data?.featureNames ?? [];
    return (feature: string) => SERIES_COLORS[Math.max(0, names.indexOf(feature)) % SERIES_COLORS.length];
  }, [usage.data?.featureNames]);

  const rows = useMemo(() => {
    const all = usage.data?.features ?? [];
    const needle = search.trim().toLowerCase();
    const filtered = needle ? all.filter((f) => prettyFeature(f.feature).toLowerCase().includes(needle) || f.feature.toLowerCase().includes(needle)) : all;
    const sorted = [...filtered].sort((a, b) => {
      const va = a[sort as keyof AIFeatureUsageRow];
      const vb = b[sort as keyof AIFeatureUsageRow];
      const cmp = typeof va === "string" && typeof vb === "string" ? va.localeCompare(vb) : Number(va) - Number(vb);
      return dir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [usage.data?.features, search, sort, dir]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visible = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  function toggleSort(key: SortKey) {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      // Numbers are almost always wanted biggest-first; names alphabetically.
      setDir(key === "feature" ? "asc" : "desc");
    }
    setPage(1);
  }

  const totals = usage.data?.totals;
  const noData = !usage.isLoading && (usage.data?.features.length ?? 0) === 0;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4" />
            Where the tokens go
          </CardTitle>
          <CardDescription>
            Consumption per feature. Tokens rather than dollars, because the cost figure is an estimate from a price list
            and tokens are what was actually used.
          </CardDescription>
        </div>
        <Select
          value={String(days)}
          onValueChange={(v) => {
            setDays(Number(v));
            setPage(1);
          }}
        >
          <SelectTrigger className="h-9 w-[9.5rem] shrink-0"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[7, 14, 30, 60, 90].map((d) => (
              <SelectItem key={d} value={String(d)}>Last {d} days</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>

      <CardContent className="grid gap-5">
        {usage.isLoading && <Skeleton className="h-64 w-full" />}

        {noData && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No AI calls in this window — nothing has consumed any tokens yet.
          </p>
        )}

        {!usage.isLoading && !noData && usage.data && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[
                { label: "Total tokens", value: compact(totals?.totalTokens ?? 0) },
                { label: "Input", value: compact(totals?.inputTokens ?? 0) },
                { label: "Output", value: compact(totals?.outputTokens ?? 0) },
                { label: "Est. cost", value: `$${(totals?.costUsd ?? 0).toFixed(2)}` }
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-xs uppercase text-muted-foreground">{s.label}</p>
                  <p className="mt-1 text-xl font-black">{s.value}</p>
                </div>
              ))}
            </div>

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Cumulative, by feature
              </p>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={usage.data.features} layout="vertical" margin={{ left: 8, right: 16 }}>
                    <CartesianGrid {...GRID_STYLE} horizontal={false} />
                    <XAxis type="number" tick={AXIS_STYLE} axisLine={false} tickLine={false} tickFormatter={compact} />
                    <YAxis
                      type="category"
                      dataKey="feature"
                      tick={AXIS_STYLE}
                      axisLine={false}
                      tickLine={false}
                      width={130}
                      tickFormatter={prettyFeature}
                    />
                    <RTooltip
                      {...TOOLTIP_STYLE}
                      formatter={(v: number, _n, item: any) => [
                        `${v.toLocaleString()} tokens · ${item.payload.calls} calls · $${item.payload.costUsd.toFixed(2)}`,
                        prettyFeature(item.payload.feature)
                      ]}
                      labelFormatter={() => ""}
                    />
                    <Bar dataKey="totalTokens" radius={[0, 4, 4, 0]}>
                      {usage.data.features.map((f) => (
                        <Cell key={f.feature} fill={colorFor(f.feature)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Day by day — a band that widens is the one that changed
              </p>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={usage.data.daily} margin={{ left: -12, right: 8 }}>
                    <CartesianGrid {...GRID_STYLE} vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={formatDay}
                      tick={AXIS_STYLE}
                      axisLine={false}
                      tickLine={false}
                      minTickGap={24}
                    />
                    <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} width={52} tickFormatter={compact} />
                    <RTooltip
                      {...TOOLTIP_STYLE}
                      labelFormatter={formatDay}
                      formatter={(v: number, name: string) => [`${v.toLocaleString()} tokens`, prettyFeature(name)]}
                    />
                    <Legend formatter={(value: string) => <span className="text-xs">{prettyFeature(value)}</span>} />
                    {usage.data.featureNames.map((name) => (
                      <Bar key={name} dataKey={name} stackId="tokens" fill={colorFor(name)} radius={[0, 0, 0, 0]} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Filter features…"
                  className="h-9 w-full sm:w-56"
                  aria-label="Filter features"
                />
                <p className="text-xs text-muted-foreground">
                  {rows.length} {rows.length === 1 ? "feature" : "features"}
                </p>
              </div>

              <div className="max-w-full overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      {COLUMNS.map((col) => (
                        <th
                          key={col.key}
                          scope="col"
                          className={cn("whitespace-nowrap px-3 py-2 font-semibold", col.numeric ? "text-right" : "text-left")}
                        >
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 hover:text-primary"
                            onClick={() => toggleSort(col.key)}
                          >
                            {col.label}
                            {sort === col.key &&
                              (dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((f) => (
                      <tr key={f.feature} className="border-b border-border last:border-0">
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-2">
                            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colorFor(f.feature) }} aria-hidden />
                            <span className="min-w-0">
                              <span className="block font-medium">{prettyFeature(f.feature)}</span>
                              <span className="block text-xs text-muted-foreground">{f.sharePct}% of tokens</span>
                            </span>
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{f.calls.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{f.inputTokens.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{f.outputTokens.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums">{f.totalTokens.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{f.avgTokensPerCall.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">${f.costUsd.toFixed(2)}</td>
                      </tr>
                    ))}
                    {visible.length === 0 && (
                      <tr>
                        <td colSpan={COLUMNS.length} className="px-3 py-8 text-center text-sm text-muted-foreground">
                          No feature matches that filter.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {pageCount > 1 && (
                <div className="flex items-center justify-end gap-2">
                  <Button size="sm" variant="outline" className="h-8" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
                    Previous
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {safePage} / {pageCount}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    disabled={safePage >= pageCount}
                    onClick={() => setPage(safePage + 1)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
