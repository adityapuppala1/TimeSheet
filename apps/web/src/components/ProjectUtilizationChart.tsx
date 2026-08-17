/**
 * WHAT: hours logged per project across the workspace, in whichever form the viewport can
 * actually render legibly — horizontal bars on a wide screen, a donut on a narrow one.
 *
 * WHY IT CHANGES FORM. It was a vertical column chart in a third-width card, and the x-axis was
 * unreadable: eight project codes competing for ~350px produced "HICS-MEHICS-ERPCS-LeaHICS-POC"
 * — labels drawn on top of each other, which is the one thing an axis exists to prevent. Widening
 * the card buys headroom and does not fix the mechanism: a vertical axis gives each category
 * `width / n` pixels, so the same failure returns at fifteen projects, or at any width on a phone.
 *
 * A HORIZONTAL bar chart inverts that. Category names live in a fixed left gutter, one per row,
 * reading left-to-right at full length — so they cannot collide no matter how many projects there
 * are, and the chart grows downward instead of squeezing sideways. It also lets the axis show the
 * project's real NAME instead of a truncated code.
 *
 * On a phone even a left gutter is too expensive, so the form changes rather than shrinking: a
 * donut, where the categories are a legend underneath and no axis exists to collide. That is
 * legitimate here because this genuinely IS part-to-whole — every project's hours are a share of
 * the workspace total.
 *
 * THE HONEST CAVEAT about the donut, recorded so nobody "improves" it back: arc length is a poor
 * instrument for comparing close values, and this data has close pairs. The mitigation is that the
 * legend prints hours and share for every slice, so no comparison depends on eyeballing an arc —
 * the donut carries the shape of the answer, the legend carries the answer. Slices are capped and
 * the tail folded into a gray "Other" rather than inventing a ninth hue.
 *
 * COLOR: the validated eight-slot categorical palette, assigned per PROJECT and stable — the hue
 * comes from the project's position in a code-sorted list, never from its rank by hours, so a
 * project does not change color when a busier month reorders the chart. Both palettes (light and
 * dark) pass the CVD, chroma, lightness and normal-vision gates; three light-mode slots sit below
 * 3:1 against the surface, which obligates visible labels — both forms ship them.
 *
 * WHO RENDERS THIS: pages/Dashboard.tsx.
 */
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { useMediaQuery } from "../lib/use-media-query";

export interface ProjectUtilizationRow {
  name: string;
  code: string;
  value: number;
}

/**
 * The validated categorical palette, referenced as THEME TOKENS rather than hex.
 *
 * `--chart-1..8` are defined for both themes in index.css, where the reasoning and the validator
 * results live. Going through tokens means this component never detects the theme in JS: an SVG
 * `fill="var(--chart-3)"` re-resolves on its own when the `dark` class flips, so there is no
 * MutationObserver, no re-render, and no chance of the chart disagreeing with the page it sits on.
 */
const SERIES_TOKENS = Array.from({ length: 8 }, (_, index) => `var(--chart-${index + 1})`);

/** The tail bucket. Deliberately NOT a ninth categorical slot — a generated hue is
 *  indistinguishable from an existing one under CVD, and "Other" is not an entity anyway. */
const OTHER_TOKEN = "var(--chart-other)";

/** Past this many slices a donut stops being readable at a glance and the arcs get too thin to
 *  hit. The tail folds into "Other"; the bar form has no such limit because it grows downward. */
const MAX_DONUT_SLICES = 8;

/** Row height for the horizontal form — enough for a 4px-radius bar plus breathing room, so the
 *  card's height is derived from the data rather than fixed (a fixed height is what crops an axis
 *  band and produces a tiny nested scrollbar). */
const BAR_ROW_PX = 34;

/**
 * The name gutter, sized to the DATA rather than guessed.
 *
 * A fixed 168px silently ate the first character of "HICS Learnings & Certifications" — a clipped
 * label is the same failure as an overlapping one, just quieter. The gutter grows with the longest
 * name up to a ceiling (past which it would starve the bars it exists to label), and anything
 * still too long is truncated with an ellipsis, which is honest about being shortened where a
 * hard crop is not. The full name stays in the tooltip either way.
 */
const GUTTER_MIN_PX = 140;
const GUTTER_MAX_PX = 260;
/** ~7px per character at fontSize 12 in the app's sans, plus the tick's own padding. */
const PX_PER_CHAR = 7;
const GUTTER_PADDING_PX = 14;

function gutterFor(rows: ProjectUtilizationRow[]): number {
  const longest = rows.reduce((max, row) => Math.max(max, row.name.length), 0);
  return Math.min(GUTTER_MAX_PX, Math.max(GUTTER_MIN_PX, longest * PX_PER_CHAR + GUTTER_PADDING_PX));
}

function truncateToGutter(name: string, gutter: number): string {
  const budget = Math.floor((gutter - GUTTER_PADDING_PX) / PX_PER_CHAR);
  return name.length <= budget ? name : `${name.slice(0, Math.max(1, budget - 1)).trimEnd()}…`;
}

export function ProjectUtilizationChart({ rows }: Readonly<{ rows: ProjectUtilizationRow[] }>) {
  // `md` — the same breakpoint the dashboard grid uses to go single-column, so the form changes at
  // the moment the card stops being wide.
  const wide = useMediaQuery("(min-width: 768px)");

  /**
   * Hue per project, from a CODE-sorted list.
   *
   * Sorting by hours here would tie color to RANK: the busiest project would always be blue, so a
   * quiet month would repaint the whole chart and a reader who learned "Apollo is blue" would be
   * misled. The code is the project's stable identity, so the hue is too.
   */
  const hueByCode = useMemo(() => {
    const codes = [...new Set(rows.map((row) => row.code))].sort((a, b) => a.localeCompare(b));
    return new Map(codes.map((code, index) => [code, SERIES_TOKENS[index % SERIES_TOKENS.length]]));
  }, [rows]);

  /** Biggest first — the reading order for "where is the time going". */
  const ranked = useMemo(() => [...rows].sort((a, b) => b.value - a.value), [rows]);
  const total = useMemo(() => ranked.reduce((sum, row) => sum + row.value, 0), [ranked]);

  if (ranked.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
        No hours logged against any project yet.
      </div>
    );
  }

  return wide ? (
    <HorizontalBars rows={ranked} hueByCode={hueByCode} />
  ) : (
    <Donut rows={ranked} hueByCode={hueByCode} total={total} />
  );
}

/* ============================== Wide: horizontal bars ============================== */

function HorizontalBars({
  rows,
  hueByCode
}: Readonly<{ rows: ProjectUtilizationRow[]; hueByCode: Map<string, string> }>) {
  // Grows with the data instead of squeezing it. `+ 24` leaves room for the value axis band.
  const height = rows.length * BAR_ROW_PX + 24;
  const gutter = gutterFor(rows);

  return (
    <div style={{ height }} data-testid="project-utilization-bars">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }}>
          {/* Vertical rules only: horizontal ones would draw a line through every bar. Solid
              hairline, not dashed — dashing reads as "threshold" when it is just a grid. */}
          <XAxis
            type="number"
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: number) => `${value}h`}
          />
          {/* The whole point of the horizontal form: a fixed gutter, one full name per row, no
              rotation and no collision however many projects there are. */}
          <YAxis
            type="category"
            dataKey="name"
            width={gutter}
            stroke="hsl(var(--muted-foreground))"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            interval={0}
            tickFormatter={(name: string) => truncateToGutter(String(name), gutter)}
          />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
            contentStyle={{
              background: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              color: "hsl(var(--popover-foreground))"
            }}
            formatter={(value: number) => [`${Number(value).toFixed(2)}h`, "Hours"]}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={18}>
            {rows.map((row) => (
              // NO `stroke` here, and that is load-bearing rather than an omission. Recharts
              // spreads a Cell's presentation props onto the Bar's `<LabelList>` text too, so a
              // 2px surface-colored ring — the separator the mark spec asks for — became a 2px
              // white outline around 11px digits and erased them: every value rendered as a single
              // faint dot (the densest pixel of the "."), while the DOM still reported the right
              // string at the right size. Caught by screenshotting the chart, not by reading it.
              //
              // The ring is unnecessary here anyway: one bar per row means the row gap already
              // separates them. The donut, where segments really do abut, uses `paddingAngle` plus
              // a stroke and has no label list to poison.
              <Cell key={row.code} fill={hueByCode.get(row.code)} />
            ))}
            {/* Visible values, which three light-mode palette slots specifically oblige (they sit
                below 3:1 against the surface). They also mean no comparison needs a hover.
                `stroke="none"` is explicit so re-adding a Cell ring cannot silently erase them
                again. */}
            <LabelList
              dataKey="value"
              position="right"
              fill="hsl(var(--muted-foreground))"
              stroke="none"
              fontSize={11}
              formatter={(value: number) => (value > 0 ? `${Number(value).toFixed(value >= 100 ? 0 : 1)}h` : "")}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ============================== Narrow: donut + legend ============================== */

function Donut({
  rows,
  hueByCode,
  total
}: Readonly<{ rows: ProjectUtilizationRow[]; hueByCode: Map<string, string>; total: number }>) {
  /** Top N by hours, with everything past the cap folded into one gray bucket rather than given a
   *  generated hue. The fold is by RANK (unlike the color assignment), which is correct: this is
   *  about which projects are big enough to read at this size, not about their identity. */
  const slices = useMemo(() => {
    if (rows.length <= MAX_DONUT_SLICES) {
      return rows.map((row) => ({ ...row, fill: hueByCode.get(row.code)! }));
    }
    const head = rows.slice(0, MAX_DONUT_SLICES - 1).map((row) => ({ ...row, fill: hueByCode.get(row.code)! }));
    const tail = rows.slice(MAX_DONUT_SLICES - 1);
    return [
      ...head,
      {
        name: `Other (${tail.length} projects)`,
        code: "__other__",
        value: tail.reduce((sum, row) => sum + row.value, 0),
        fill: OTHER_TOKEN
      }
    ];
  }, [rows, hueByCode]);

  const share = (value: number) => (total > 0 ? (value / total) * 100 : 0);

  return (
    <div className="grid gap-3" data-testid="project-utilization-donut">
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius="58%"
              outerRadius="86%"
              // The 2px surface gap between fills, as an angular pad rather than a drawn border.
              paddingAngle={2}
              stroke="hsl(var(--card))"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((slice) => (
                <Cell key={slice.code} fill={slice.fill} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: "hsl(var(--popover))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 8,
                color: "hsl(var(--popover-foreground))"
              }}
              formatter={(value: number, name: string) => [
                `${Number(value).toFixed(2)}h · ${share(Number(value)).toFixed(0)}%`,
                name
              ]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/*
        The legend is not decoration here, it is the reading instrument. An arc is a poor way to
        compare close values, so every slice prints its hours and its share — the donut carries the
        shape, this carries the answer. It doubles as the table view the contrast WARN obliges, and
        as the identity channel that keeps meaning off color alone.
      */}
      <ul className="grid gap-1.5 text-xs">
        {slices.map((slice) => (
          <li key={slice.code} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: slice.fill }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-foreground">{slice.name}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {slice.value.toFixed(1)}h · {share(slice.value).toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
