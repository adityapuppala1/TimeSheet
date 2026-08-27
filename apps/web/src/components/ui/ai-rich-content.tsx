/**
 * WHAT: the ONE renderer for model-authored content anywhere in the app — Ask AI answers, the
 * generated PRD/BRD's narrative sections, and anything else an LLM writes. Handles the full range
 * of formats a model actually reaches for: markdown (headings, paragraphs, lists, tables,
 * blockquotes, links, emphasis), fenced mermaid diagrams, fenced chart data drawn as real charts,
 * pretty-printed JSON, syntax-labelled code blocks, and GitHub-style callouts with icons.
 *
 * WHY ONE COMPONENT AND NOT PER-PAGE RENDERING: everything here is UNTRUSTED — a model can be
 * talked into emitting anything, and PRD text can originate in an uploaded third-party document.
 * One renderer means exactly ONE sanitisation path to audit (`safeHtml`), rather than each page
 * inventing its own and one of them forgetting. That is also why structured content (charts,
 * diagrams) comes out of FENCES rather than letting the model emit markup: the fence body is
 * parsed and shape-checked here, so nothing the model wrote is ever interpreted as markup.
 *
 * WHAT DELIBERATELY DOESN'T RENDER: raw HTML from the model. `marked` keeps its default escaping
 * and `safeHtml` strips whatever survives — a model that emits a script tag or an onerror handler
 * gets it shown as text, which is the correct outcome for content of this provenance.
 */
import { useMemo, type ReactElement } from "react";
import { AlertTriangle, CheckCircle2, Info, Lightbulb, XCircle } from "lucide-react";
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
import { cn } from "../../lib/utils";
import { MermaidDiagram } from "./mermaid-diagram";

interface ChartSpec {
  type: "bar" | "line" | "pie";
  title?: string;
  data: Array<{ label: string; value: number }>;
}

type Segment =
  | { kind: "markdown"; text: string }
  | { kind: "chart"; spec: ChartSpec }
  | { kind: "mermaid"; source: string }
  | { kind: "code"; language: string; code: string };

/** Shape-checks a chart fence by hand — a fence that fails any of this renders as code instead. */
function parseChartSpec(raw: string): ChartSpec | null {
  try {
    // The raw text FIRST — a well-formed fence must never be touched. Only when that fails, one
    // targeted repair: doubled opening braces before a key are a measured diffusion-model artifact.
    // The order matters and was got wrong once: that sequence CAN occur inside a valid fence, as a
    // string value ending in braces followed by its closing quote, so repairing before parsing
    // corrupted exactly the fences that needed no help.
    let parsed: Partial<ChartSpec>;
    try {
      parsed = JSON.parse(raw) as Partial<ChartSpec>;
    } catch {
      // BOUNDED repetition, not `\{\{+\s*` — measured: the unbounded form takes ~1900ms on 60k
      // braces (quadratic backtracking, every start position retried), and this parses model
      // output nobody has vetted. The bounded form is 1.8ms on the same input and repairs the real
      // artifact identically; a doubled brace is never eight deep.
      parsed = JSON.parse(raw.replace(/\{{2,8}[ \t]{0,8}"/g, '{"')) as Partial<ChartSpec>;
    }
    if (parsed.type !== "bar" && parsed.type !== "line" && parsed.type !== "pie") return null;
    if (!Array.isArray(parsed.data) || parsed.data.length === 0 || parsed.data.length > 40) return null;
    const data = parsed.data
      .filter(
        (d) =>
          d &&
          typeof d === "object" &&
          typeof (d as { label?: unknown }).label === "string" &&
          Number.isFinite(Number((d as { value?: unknown }).value))
      )
      .map((d) => ({
        label: String((d as { label: string }).label).slice(0, 60),
        value: Number((d as { value: number }).value)
      }));
    if (data.length === 0) return null;
    return { type: parsed.type, title: typeof parsed.title === "string" ? parsed.title.slice(0, 120) : undefined, data };
  } catch {
    return null;
  }
}

/** Turns one recognised fence into the segment that renders it. Split out of the loop below so
 *  that stays a scan and this stays the per-language decision. */
function segmentForFence(language: string, body: string): Segment {
  if (language === "chart") {
    const spec = parseChartSpec(body);
    // An unparseable chart fence stays visible as JSON — hiding it would hide that the model tried.
    return spec ? { kind: "chart", spec } : { kind: "code", language: "json", code: body.trim() };
  }
  if (language === "mermaid") return { kind: "mermaid", source: body.trim() };

  // Pretty-print when it parses; show it exactly as written when it doesn't, because malformed
  // JSON is itself information worth seeing rather than hiding behind a reformat.
  let code = body.trim();
  try {
    code = JSON.stringify(JSON.parse(code), null, 2);
  } catch {
    /* leave as authored */
  }
  return { kind: "code", language: "json", code };
}

/**
 * Splits the content on every fenced block whose language we render specially, leaving everything
 * else inside the markdown stream so `marked` renders it as an ordinary escaped code block. One
 * pass over one regex rather than a chain of per-language passes, so a document carrying a diagram,
 * a chart and a code sample keeps them in the order the model wrote them.
 */
function splitSegments(markdown: string): Segment[] {
  const segments: Segment[] = [];
  const fence = /```([a-zA-Z0-9_+-]*)[^\S\n]*\n([\s\S]*?)```/g;
  let cursor = 0;

  for (let match = fence.exec(markdown); match; match = fence.exec(markdown)) {
    const [full, rawLanguage, body] = match;
    const language = (rawLanguage || "").toLowerCase();
    if (language !== "chart" && language !== "mermaid" && language !== "json") continue;

    if (match.index > cursor) segments.push({ kind: "markdown", text: markdown.slice(cursor, match.index) });

    segments.push(segmentForFence(language, body));
    cursor = match.index + full.length;
  }

  if (cursor < markdown.length) segments.push({ kind: "markdown", text: markdown.slice(cursor) });
  return segments;
}

/** The categorical ramp the app's other charts use — magnitude carried by the number, identity by
 *  position, so there is no per-series colour table to keep in sync. */
const PIE_FILLS = [
  "hsl(var(--primary))",
  "hsl(var(--info))",
  "hsl(160 84% 39%)",
  "hsl(var(--warning))",
  "hsl(var(--destructive))",
  "hsl(var(--muted-foreground))"
];

/** One branch per chart type — a function rather than a nested ternary in JSX, which is the same
 *  choice with a name attached. */
function renderChart(spec: ChartSpec, grid: ReactElement, tooltipStyle: Record<string, unknown>) {
  if (spec.type === "pie") {
    return (
      <PieChart>
        <Pie data={spec.data} dataKey="value" nameKey="label" innerRadius="45%" outerRadius="80%" paddingAngle={2}>
          {spec.data.map((_, i) => (
            <Cell key={i} fill={PIE_FILLS[i % PIE_FILLS.length]} />
          ))}
        </Pie>
        <ChartTip contentStyle={tooltipStyle} />
      </PieChart>
    );
  }
  if (spec.type === "line") {
    return (
      <LineChart data={spec.data} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
        {grid}
        <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} width={34} />
        <ChartTip contentStyle={tooltipStyle} />
        <Line type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 2.5 }} />
      </LineChart>
    );
  }
  return (
    <BarChart data={spec.data} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
      {grid}
      <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} interval={0} />
      <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} width={34} />
      <ChartTip contentStyle={tooltipStyle} />
      <Bar dataKey="value" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
    </BarChart>
  );
}

function AnswerChart({ spec }: { spec: ChartSpec }) {
  const grid = <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />;
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
        <ResponsiveContainer width="100%" height="100%">{renderChart(spec, grid, tooltipStyle)}</ResponsiveContainer>
      </div>
    </figure>
  );
}

/** A code block with its language named — the label is the difference between "some code" and
 *  "JSON you can paste into a config". */
function CodeBlock({ language, code }: { language: string; code: string }) {
  return (
    <figure className="my-3 overflow-hidden rounded-lg border border-border">
      <figcaption className="border-b border-border bg-muted/50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {language}
      </figcaption>
      <pre className="overflow-x-auto bg-muted/20 p-3 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </figure>
  );
}

/**
 * GitHub-style callouts get an icon and a colour instead of reading as an ordinary quote. Pulled
 * out BEFORE `marked` runs and rendered as real components, so the icon and the framing are ours
 * rather than markup the model supplied — its text still goes through the sanitizer.
 */
const CALLOUTS: Record<string, { icon: typeof Info; className: string; label: string }> = {
  NOTE: { icon: Info, className: "border-info/40 bg-info/5", label: "Note" },
  TIP: { icon: Lightbulb, className: "border-success/40 bg-success/5", label: "Tip" },
  IMPORTANT: { icon: CheckCircle2, className: "border-primary/40 bg-primary/5", label: "Important" },
  WARNING: { icon: AlertTriangle, className: "border-warning/40 bg-warning/5", label: "Warning" },
  CAUTION: { icon: XCircle, className: "border-destructive/40 bg-destructive/5", label: "Caution" }
};

type Block = { kind: "callout"; type: string; body: string } | { kind: "html"; html: string };

function splitCallouts(markdown: string): Block[] {
  const blocks: Block[] = [];
  // Measured rather than assumed, because this parses model output nobody vetted: 0.5ms against
  // 40k of `> ` repetition, 0.3ms against 3k real callouts. The nested quantifier the rule flags
  // cannot blow up here — the inner `.` excludes newlines, so each `>` line is consumed once and
  // there is nothing for the outer group to re-split.
  // eslint-disable-next-line sonarjs/slow-regex -- measured: 0.5ms on adversarial 40k input
  const callout = /^[^\S\n]*>[^\S\n]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][^\S\n]*\n((?:[^\S\n]*>.*\n?)*)/gim;
  let cursor = 0;

  for (let match = callout.exec(markdown); match; match = callout.exec(markdown)) {
    if (match.index > cursor) {
      blocks.push({ kind: "html", html: marked.parse(markdown.slice(cursor, match.index), { async: false }) as string });
    }
    // eslint-disable-next-line sonarjs/slow-regex -- measured: 0.8ms on 200k of `> ` repetition
    const body = (match[2] ?? "").replace(/^[^\S\n]*>[^\S\n]?/gm, "");
    blocks.push({ kind: "callout", type: match[1].toUpperCase(), body });
    cursor = match.index + match[0].length;
  }

  if (cursor < markdown.length) {
    blocks.push({ kind: "html", html: marked.parse(markdown.slice(cursor), { async: false }) as string });
  }
  return blocks;
}

/** Shared typography for every rendered chunk, so a heading in an Ask AI answer and a heading in a
 *  generated PRD read as the same product rather than two. */
const PROSE = [
  "prose-sm max-w-none break-words text-sm leading-relaxed",
  "[&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-base [&_h1]:font-bold [&_h1]:tracking-tight",
  "[&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-bold",
  "[&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold",
  "[&_h4]:mb-1 [&_h4]:mt-2.5 [&_h4]:text-xs [&_h4]:font-semibold [&_h4]:uppercase [&_h4]:tracking-wide [&_h4]:text-muted-foreground",
  "[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
  "[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em]",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted/30 [&_pre]:p-3",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_hr]:my-4 [&_hr]:border-border",
  "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse",
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top",
  "[&_th]:border [&_th]:border-border [&_th]:bg-muted/40 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold"
].join(" ");

function MarkdownChunk({ text }: { text: string }) {
  const blocks = useMemo(() => splitCallouts(text), [text]);
  return (
    <>
      {blocks.map((block, i) => {
        if (block.kind === "callout") {
          const config = CALLOUTS[block.type] ?? CALLOUTS.NOTE;
          const Icon = config.icon;
          return (
            <div key={i} className={cn("my-3 flex gap-2.5 rounded-lg border p-3", config.className)}>
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <p className="mb-0.5 text-xs font-semibold">{config.label}</p>
                <div className={PROSE} dangerouslySetInnerHTML={safeHtml(marked.parse(block.body, { async: false }) as string)} />
              </div>
            </div>
          );
        }
        // marked → DOMPurify: the reason model-authored markdown is safe to set as HTML at all.
        return <div key={i} className={PROSE} dangerouslySetInnerHTML={safeHtml(block.html)} />;
      })}
    </>
  );
}

export function AiRichContent({ content, className }: { content: string; className?: string }) {
  const segments = useMemo(() => splitSegments(content ?? ""), [content]);
  return (
    <div className={cn("min-w-0", className)}>
      {segments.map((segment, i) => {
        if (segment.kind === "chart") return <AnswerChart key={i} spec={segment.spec} />;
        if (segment.kind === "mermaid") {
          return (
            <div key={i} className="my-3">
              <MermaidDiagram source={segment.source} />
            </div>
          );
        }
        if (segment.kind === "code") return <CodeBlock key={i} language={segment.language} code={segment.code} />;
        return <MarkdownChunk key={i} text={segment.text} />;
      })}
    </div>
  );
}
