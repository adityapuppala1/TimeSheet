/**
 * WHAT: renders an AI answer — markdown through the same `marked` + `safeHtml` pipe What's-new
 * uses, plus ```chart fences drawn as real recharts charts.
 *
 * WHY CHARTS COME OUT OF FENCES: the model is told it may emit one fenced JSON block per answer
 * with numbers a tool actually returned. Parsing that here — rather than letting the model emit
 * markup — keeps the whole answer inside the sanitizer: everything textual goes through DOMPurify,
 * and the chart data goes through a zod-ish shape check before it touches a chart component. A
 * fence that does not parse renders as a code block, which is exactly what it is at that point.
 *
 * WHO USES THIS: the Ask AI page. Anything else that renders model-authored markdown should come
 * through here too, so there is exactly one sanitisation path to audit.
 */
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as ChartTip,
  XAxis,
  YAxis
} from "recharts";
import { marked } from "marked";
import { safeHtml } from "../../lib/safe-html";

interface ChartSpec {
  type: "bar" | "line" | "pie";
  title?: string;
  data: Array<{ label: string; value: number }>;
}

type Segment = { kind: "markdown"; text: string } | { kind: "chart"; spec: ChartSpec };

/** Shape-checks a chart fence by hand — a fence that fails any of this renders as code instead. */
function parseChartSpec(raw: string): ChartSpec | null {
  try {
    // The raw text FIRST — a well-formed fence must never be touched. Only when that fails, one
    // targeted repair: doubled opening braces before a key (`{{"label"`) are a measured
    // diffusion-model artifact. The order matters and was got wrong once: the sequence `{{"` CAN
    // occur inside a valid fence, as a string value ending in braces followed by its closing quote,
    // so repairing before parsing corrupted exactly the fences that needed no help.
    let parsed: Partial<ChartSpec>;
    try {
      parsed = JSON.parse(raw) as Partial<ChartSpec>;
    } catch {
      parsed = JSON.parse(raw.replace(/\{\{+\s*"/g, '{"')) as Partial<ChartSpec>;
    }
    if (parsed.type !== "bar" && parsed.type !== "line" && parsed.type !== "pie") return null;
    if (!Array.isArray(parsed.data) || parsed.data.length === 0 || parsed.data.length > 40) return null;
    const data = parsed.data
      .filter((d) => d && typeof d === "object" && typeof (d as { label?: unknown }).label === "string" && Number.isFinite(Number((d as { value?: unknown }).value)))
      .map((d) => ({ label: String((d as { label: string }).label).slice(0, 60), value: Number((d as { value: number }).value) }));
    if (data.length === 0) return null;
    return { type: parsed.type, title: typeof parsed.title === "string" ? parsed.title.slice(0, 120) : undefined, data };
  } catch {
    return null;
  }
}

function splitSegments(markdown: string): Segment[] {
  const segments: Segment[] = [];
  const fence = /```chart\s*\n([\s\S]*?)```/g;
  let cursor = 0;
  for (let match = fence.exec(markdown); match; match = fence.exec(markdown)) {
    if (match.index > cursor) segments.push({ kind: "markdown", text: markdown.slice(cursor, match.index) });
    const spec = parseChartSpec(match[1]);
    // An unparseable fence stays visible as code — hiding it would hide that the model tried.
    segments.push(spec ? { kind: "chart", spec } : { kind: "markdown", text: "```json\n" + match[1] + "```" });
    cursor = match.index + match[0].length;
  }
  if (cursor < markdown.length) segments.push({ kind: "markdown", text: markdown.slice(cursor) });
  return segments;
}

/** The categorical ramp the app's other charts use — magnitude carried by the number, identity by
 *  position, so no per-series colour table to keep in sync. */
const PIE_FILLS = ["hsl(var(--primary))", "hsl(var(--info))", "hsl(160 84% 39%)", "hsl(var(--warning))", "hsl(var(--destructive))", "hsl(var(--muted-foreground))"];

function AnswerChart({ spec }: { spec: ChartSpec }) {
  const tooltipStyle = {
    borderRadius: 8,
    border: "1px solid hsl(var(--border))",
    background: "hsl(var(--popover))",
    color: "hsl(var(--popover-foreground))",
    fontSize: 12
  };

  return (
    <figure className="my-3 rounded-lg border border-border p-3">
      {spec.title && <figcaption className="mb-2 text-xs font-semibold text-foreground">{spec.title}</figcaption>}
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {spec.type === "pie" ? (
            <PieChart>
              <Pie data={spec.data} dataKey="value" nameKey="label" innerRadius="45%" outerRadius="80%" paddingAngle={2}>
                {spec.data.map((_, i) => (
                  <Cell key={i} fill={PIE_FILLS[i % PIE_FILLS.length]} />
                ))}
              </Pie>
              <ChartTip contentStyle={tooltipStyle} />
            </PieChart>
          ) : spec.type === "line" ? (
            <LineChart data={spec.data} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} width={34} />
              <ChartTip contentStyle={tooltipStyle} />
              <Line type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 2.5 }} />
            </LineChart>
          ) : (
            <BarChart data={spec.data} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} interval={0} />
              <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} width={34} />
              <ChartTip contentStyle={tooltipStyle} />
              <Bar dataKey="value" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

export function AiMarkdown({ markdown }: { markdown: string }) {
  const segments = useMemo(() => splitSegments(markdown), [markdown]);
  return (
    <div className="min-w-0">
      {segments.map((segment, i) =>
        segment.kind === "chart" ? (
          <AnswerChart key={i} spec={segment.spec} />
        ) : (
          <div
            key={i}
            className="prose-sm max-w-none break-words text-sm leading-relaxed [&_table]:my-2 [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-muted/40 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left"
            // marked → DOMPurify — the exact pipe What's-new renders the changelog through, and the
            // reason model-authored markdown is safe to set as HTML at all.
            dangerouslySetInnerHTML={safeHtml(marked.parse(segment.text, { async: false }) as string)}
          />
        )
      )}
    </div>
  );
}
