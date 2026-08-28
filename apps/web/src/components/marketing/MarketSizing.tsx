/**
 * WHAT: the pitch deck's TAM / SAM / SOM slide — and, more importantly, the arithmetic behind it.
 *
 * THE RULE THIS FILE IS BUILT AROUND. `docs/MARKETING_PAGES.md` says a pitch deck that overpromises
 * loses a deal at diligence, and market sizing is the single most diligence-scrutinised slide in a
 * deck. A number invented here is not a rounding error, it is the moment an investor stops
 * believing the rest of the page. So:
 *
 *   - Every figure is one of exactly two things, and the UI says which: SOURCED, with a link to the
 *     firm that published it, or an ASSUMPTION, which the reader can change.
 *   - The assumptions are SLIDERS. If somebody disagrees with "we serve the 10–500 seat band", they
 *     move it and watch SAM and SOM recompute. A slide that survives its own assumptions being
 *     challenged is worth more than one that hides them.
 *   - Nothing here claims traction. There are no customers, no revenue, no pipeline — the same rule
 *     the rest of these pages follow. This is the size of the pond, not the size of the catch.
 *
 * WHY THE CATEGORY FIGURES ARE SHOWN AS RANGES. The published estimates genuinely disagree: PSA for
 * 2025 lands between $12.5B and $14.4B depending on the firm, and time tracking spans $3.9B to
 * $18.3B because the firms draw the category's edges in completely different places. Picking the
 * largest and presenting it as fact is the standard move and it is exactly what gets caught. The
 * low end of each range is what feeds the maths here, and the range is shown so the reader can see
 * the choice was deliberately conservative.
 *
 * OVERLAP IS ACKNOWLEDGED RATHER THAN QUIETLY SUMMED. A PSA suite and an ITSM suite both count some
 * of the same spend, so the three categories added together overstate the true envelope. The TAM
 * used below applies a haircut for that, and it is a slider too, because its true value is not
 * knowable from public reports and pretending otherwise would be the same lie in a smaller font.
 */
import { useEffect, useRef, useState } from "react";
import { ExternalLink, Globe2, Layers, SlidersHorizontal, Target } from "lucide-react";

/* ── The sourced layer ────────────────────────────────────────────────────────────────────────── */

interface Category {
  key: string;
  name: string;
  /** What TimeSphere does that puts it in this category — the claim has to map to shipped code. */
  because: string;
  /** 2025 estimates, in USD billions, low and high across the firms found. */
  low: number;
  high: number;
  cagr: string;
  sources: Array<{ firm: string; href: string }>;
}

/**
 * Three categories, because the product genuinely sits across three. That is the honest reason for
 * a wider TAM than any single category — not a wider TAM chosen first and justified afterwards.
 */
const CATEGORIES: Category[] = [
  {
    key: "psa",
    name: "Professional services automation",
    because: "Projects, budgets, utilisation and billable hours in one system",
    low: 12.5,
    high: 14.4,
    cagr: "11–14.9%",
    sources: [
      { firm: "Grand View Research", href: "https://www.grandviewresearch.com/industry-analysis/professional-services-automation-software-market" },
      { firm: "Fortune Business Insights", href: "https://www.fortunebusinessinsights.com/industry-reports/professional-service-automation-software-market-101785" },
      { firm: "Mordor Intelligence", href: "https://www.mordorintelligence.com/industry-reports/professional-services-automation-market" }
    ]
  },
  {
    key: "itsm",
    name: "IT service management",
    because: "Tickets, SLAs, escalations and change management with approvals",
    low: 13.6,
    high: 15.3,
    cagr: "14–16.5%",
    sources: [
      { firm: "Fortune Business Insights", href: "https://www.fortunebusinessinsights.com/itsm-market-109485" },
      { firm: "Grand View Research", href: "https://www.grandviewresearch.com/industry-analysis/it-service-management-market-report" }
    ]
  },
  {
    key: "time",
    name: "Time tracking",
    because: "Timesheets, approvals and the attested record behind an invoice",
    low: 3.9,
    high: 6.1,
    cagr: "13–17.4%",
    sources: [
      { firm: "Research and Markets", href: "https://www.researchandmarkets.com/reports/5970908/time-tracking-software-market-report" },
      { firm: "Mordor Intelligence", href: "https://www.mordorintelligence.com/industry-reports/time-tracking-software-market" }
    ]
  }
];

const RAW_TAM = CATEGORIES.reduce((sum, c) => sum + c.low, 0);

/* ── The count-up ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Counts to `value` when the element first enters view, and jumps straight to it afterwards.
 *
 * ON THE COST, given what the `.ai-gradient-text` comment in index.css records about always-running
 * animations: this one runs ONCE, for 900ms, and stops. It also drives a number rather than a
 * paint-heavy property. The thing that made the AI labels expensive was an infinite animation of a
 * non-compositable property on six elements at once; a one-shot counter is not that.
 *
 * It re-runs when `value` changes, which is what makes the sliders feel connected to the figures —
 * but only after the first reveal, so dragging never restarts an intro.
 */
function useCountUp(value: number, decimals = 1) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState(0);
  const seen = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const run = () => {
      if (reduced) {
        setShown(value);
        return;
      }
      const from = seen.current ? shown : 0;
      const t0 = performance.now();
      let raf = 0;
      const tick = (now: number) => {
        const t = Math.min((now - t0) / 900, 1);
        // easeOutCubic: quick to the neighbourhood, gentle into the final digit.
        setShown(from + (value - from) * (1 - Math.pow(1 - t, 3)));
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    };

    if (seen.current) return run();

    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          seen.current = true;
          run();
          io.disconnect();
        }
      },
      { threshold: 0.35 }
    );
    io.observe(el);
    return () => io.disconnect();
    // `shown` is deliberately out of the deps: including it restarts the animation on every frame
    // it sets, which is an infinite loop rather than a count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return { ref, text: shown.toFixed(decimals) };
}

/**
 * A figure in billions, EXCEPT when billions stop being a sensible unit.
 *
 * SOM is a fraction of a percent of a $22B market, so at one decimal place in billions it renders
 * as "$0.0B" — which on a pitch deck reads as a broken component, not as a small number. Below a
 * billion it switches to millions, where the same value is "$18M" and means something. The
 * threshold is where the unit stops carrying information, not a magic number.
 */
function Figure({ value, className = "" }: { value: number; className?: string }) {
  const inMillions = value < 1;
  const shown = inMillions ? value * 1000 : value;
  const { ref, text } = useCountUp(shown, inMillions ? 0 : 1);
  return (
    <span ref={ref} className={`tabular-nums ${className}`}>
      ${text}
      {inMillions ? "M" : "B"}
    </span>
  );
}

/* ── Labels that make the epistemics visible ──────────────────────────────────────────────────── */

function SourcedTag() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-success ring-1 ring-inset ring-success/20">
      Sourced
    </span>
  );
}

function AssumptionTag() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-warning ring-1 ring-inset ring-warning/20">
      Assumption
    </span>
  );
}

function Assumption({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
  format
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}) {
  const id = `assumption-${label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div className="grid gap-1.5 rounded-lg border border-border bg-background/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-semibold">
          {label}
        </label>
        <span className="text-sm font-bold tabular-nums text-primary">{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="market-slider"
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="text-xs leading-5 text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

/* ── The slide ────────────────────────────────────────────────────────────────────────────────── */

export function MarketSizing() {
  // Defaults chosen to be defensible rather than flattering — each is argued in its own hint.
  const [overlap, setOverlap] = useState(25);
  const [segment, setSegment] = useState(35);
  const [geography, setGeography] = useState(45);
  const [share, setShare] = useState(0.5);

  const tam = RAW_TAM * (1 - overlap / 100);
  const sam = tam * (segment / 100) * (geography / 100);
  const som = sam * (share / 100);

  // Widths for the nested bars. A floor keeps the SOM band legible when it is a fraction of a
  // percent — a bar too thin to see communicates nothing, and the figure beside it is the truth.
  const samWidth = Math.max((sam / tam) * 100, 8);
  const somWidth = Math.max((som / tam) * 100, 3);

  return (
    <div className="grid gap-8 lg:grid-cols-[1.05fr_1fr] lg:items-start">
      {/* ---------------------------------------------------------------- The three nested bands */}
      <div className="grid gap-4">
        {[
          {
            key: "tam",
            tag: "TAM",
            name: "Total addressable market",
            value: tam,
            width: 100,
            tone: "from-primary/25 to-primary/5 border-primary/40",
            note: "The three software categories this product sits across, less an overlap haircut."
          },
          {
            key: "sam",
            tag: "SAM",
            name: "Serviceable available market",
            value: sam,
            width: samWidth,
            tone: "from-info/30 to-info/5 border-info/50",
            note: "The seat band and the regions this deployment model actually serves today."
          },
          {
            key: "som",
            tag: "SOM",
            name: "Serviceable obtainable market",
            value: som,
            width: somWidth,
            tone: "from-success/40 to-success/10 border-success/60",
            note: "A share of that, at the point the assumptions on the right are met."
          }
        ].map((band, i) => (
          <div
            key={band.key}
            style={{ animationDelay: `${i * 110}ms` }}
            className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-4 motion-safe:duration-500 motion-safe:fill-mode-backwards"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-black uppercase tracking-wider text-muted-foreground">
                {band.tag} <span className="font-semibold normal-case tracking-normal">· {band.name}</span>
              </p>
              <Figure value={band.value} className="text-2xl font-black" />
            </div>
            {/* The bar is the ratio; the number beside it is the fact. Both are shown because a
                reader who only sees the bar cannot tell 0.4% from 4%. */}
            <div className="mt-1.5 h-11 w-full overflow-hidden rounded-lg border border-border bg-muted/30">
              <div
                className={`h-full rounded-lg border bg-gradient-to-r transition-[width] duration-500 ease-out motion-reduce:transition-none ${band.tone}`}
                style={{ width: `${band.width}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{band.note}</p>
          </div>
        ))}

        {/* ------------------------------------------------------------------ Where TAM came from */}
        <div className="mt-2 grid gap-2.5 rounded-xl border border-border bg-muted/20 p-4">
          <p className="flex items-center gap-2 text-sm font-bold">
            <Layers className="h-4 w-4 text-primary" aria-hidden />
            What makes up the TAM
            <SourcedTag />
          </p>
          {CATEGORIES.map((c) => (
            <div key={c.key} className="grid gap-0.5 border-t border-border/60 pt-2.5 first:border-0 first:pt-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-sm font-semibold">{c.name}</span>
                <span className="text-sm font-bold tabular-nums">
                  ${c.low}B–${c.high}B <span className="font-normal text-muted-foreground">· {c.cagr} CAGR</span>
                </span>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">{c.because}</p>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span className="font-medium">2025 estimates:</span>
                {c.sources.map((s) => (
                  <a
                    key={s.firm}
                    href={s.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="focus-ring inline-flex items-center gap-1 rounded text-primary hover:underline"
                  >
                    {s.firm}
                    <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                ))}
              </p>
            </div>
          ))}
          {/* The sentence that keeps this slide honest at diligence. */}
          <p className="border-t border-border/60 pt-2.5 text-xs leading-5 text-muted-foreground">
            The firms disagree — time tracking alone is published anywhere from $3.9B to $18.3B for the same year, because
            each draws the category's edges differently. The <strong className="font-semibold text-foreground">low end of every
            range</strong> is what feeds the arithmetic here. The three categories also overlap, so they are not simply added.
          </p>
        </div>
      </div>

      {/* --------------------------------------------------------------------- The assumptions */}
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex items-center gap-2 text-sm font-bold">
            <SlidersHorizontal className="h-4 w-4 text-primary" aria-hidden />
            The assumptions, and yours
          </p>
          <AssumptionTag />
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          None of these four come from a report, so none of them are presented as facts. Move them and the figures on the left
          move with you — the slide is meant to survive disagreement rather than avoid it.
        </p>

        <Assumption
          label="Category overlap"
          hint="A PSA suite and an ITSM suite bill for some of the same work, so the three categories cannot simply be added. This haircut is the correction, and its true value is not knowable from public reports."
          value={overlap}
          min={0}
          max={50}
          step={5}
          onChange={setOverlap}
          format={(v) => `−${v}%`}
        />
        <Assumption
          label="Seat band served"
          hint="The share of that spend sitting in organisations of roughly 10–500 seats — the band the three plan tiers are actually priced for. Enterprise-wide deployments are excluded here rather than counted optimistically."
          value={segment}
          min={10}
          max={70}
          step={5}
          onChange={setSegment}
          format={(v) => `${v}%`}
        />
        <Assumption
          label="Regions reachable"
          hint="Where this can be sold and supported today: English-speaking markets plus EMEA, self-hosted or single-tenant SaaS. It excludes markets needing localisation or in-country data residency that has not been built."
          value={geography}
          min={10}
          max={100}
          step={5}
          onChange={setGeography}
          format={(v) => `${v}%`}
        />
        <Assumption
          label="Share of SAM captured"
          hint="What a focused product could hold in that segment within a few years. Deliberately set below one percent — a sizing slide that assumes double-digit share of its own SAM is the one nobody believes."
          value={share}
          min={0.1}
          max={5}
          step={0.1}
          onChange={setShare}
          format={(v) => `${v.toFixed(1)}%`}
        />

        <div className="grid gap-2 rounded-xl border border-border bg-muted/20 p-4">
          <p className="flex items-center gap-2 text-sm font-bold">
            <Target className="h-4 w-4 text-primary" aria-hidden />
            The arithmetic, in full
          </p>
          <p className="font-mono text-xs leading-6 text-muted-foreground">
            TAM = (${CATEGORIES[0].low} + ${CATEGORIES[1].low} + ${CATEGORIES[2].low})B × (1 − {overlap}%) ={" "}
            <strong className="font-bold text-foreground">${tam.toFixed(1)}B</strong>
            <br />
            SAM = TAM × {segment}% × {geography}% = <strong className="font-bold text-foreground">${sam.toFixed(2)}B</strong>
            <br />
            SOM = SAM × {share.toFixed(1)}% ={" "}
            <strong className="font-bold text-foreground">${(som * 1000).toFixed(0)}M</strong>{" "}
            <span className="not-italic">of annual spend</span>
          </p>
          <p className="flex items-start gap-2 border-t border-border/60 pt-2.5 text-xs leading-5 text-muted-foreground">
            <Globe2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Every category is growing double digits, so this is a sizing of today's spend, not a forecast. The CAGRs above are
            what the same firms publish; none of them is applied to the figures here.
          </p>
        </div>
      </div>
    </div>
  );
}
