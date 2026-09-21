/**
 * The product's idea, drawn: five things that are usually five tools, on one loop.
 *
 * Plan → Tickets → Hours → Approval → Proof, as nodes on an orbit with a pulse travelling the path
 * and a "verified" mark at the centre — because the one thing this product does that the category
 * does not is close that loop: the plan is compared against the hours that were actually approved,
 * and the approval becomes a signed record.
 *
 * WHY HAND-AUTHORED SVG, animated in CSS: it is the exact form an SVG animation tool exports, it is
 * a few kilobytes against a WebGL scene's megabyte, it inherits the theme (`--primary`, `--info`,
 * `--success`) so it is correct in both modes without a second asset, and it is text — every label
 * is real, readable text, not pixels. Every mark is original; nothing here is anyone else's brand.
 *
 * MOTION IS OPT-IN BY THE READER. Every animation lives under `prefers-reduced-motion:
 * no-preference`. Somebody who asked their system for less motion gets the same drawing, still —
 * which is a complete illustration, not a broken one, because nothing is communicated only by
 * movement.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";

const NODES = [
  { key: "plan", label: "Plan", angle: -90, tone: "primary" },
  { key: "tickets", label: "Tickets", angle: -18, tone: "info" },
  { key: "hours", label: "Hours", angle: 54, tone: "primary" },
  { key: "approval", label: "Approval", angle: 126, tone: "info" },
  { key: "proof", label: "Proof", angle: 198, tone: "success" }
] as const;

const R = 118;
const CX = 160;
const CY = 160;

function pos(angleDeg: number) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) };
}

const TONE: Record<(typeof NODES)[number]["tone"], string> = {
  primary: "hsl(var(--primary))",
  info: "hsl(var(--info))",
  success: "hsl(var(--success))"
};

export function ProductLoop({ className, compact = false }: { className?: string; compact?: boolean }) {
  /**
   * PAUSED WHEN IT IS NOT ON SCREEN — and this is not a micro-optimisation, it was most of an idle
   * page's cost. Measured with CDP: eleven of these animations ran at once, every one of them on a
   * property the compositor cannot take (`stroke-dashoffset`, and transforms on SVG nodes), so each
   * frame forced a style recalculation and a layout. An idle landing page was doing 119 layouts a
   * second, for a drawing the reader had scrolled past minutes ago.
   *
   * `animation-play-state` is the whole fix: the animations keep their state and resume exactly
   * where they stopped, and a paused animation costs nothing at all. IntersectionObserver missing
   * (or the drawing never leaving the viewport) leaves it playing, which is the old behaviour.
   */
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [onScreen, setOnScreen] = useState(true);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry?.isIntersecting ?? true), { rootMargin: "10% 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={hostRef} data-loop-playing={onScreen ? "true" : "false"} className={cn("product-loop", className)} aria-hidden={compact ? undefined : false}>
      <svg
        viewBox="0 0 320 320"
        role="img"
        aria-labelledby="product-loop-title product-loop-desc"
        className="h-auto w-full max-w-[22rem]"
      >
        <title id="product-loop-title">One loop: plan, tickets, hours, approval, proof</title>
        <desc id="product-loop-desc">
          Five stages of work arranged on a circle. A pulse travels from planning through tickets and logged hours to approval and a
          signed proof, then back to the plan, which is compared against what was actually approved.
        </desc>

        <defs>
          <linearGradient id="loop-stroke" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="hsl(var(--primary))" />
            <stop offset="1" stopColor="hsl(var(--info))" />
          </linearGradient>
          <radialGradient id="loop-glow">
            <stop offset="0" stopColor="hsl(var(--primary))" stopOpacity="0.35" />
            <stop offset="1" stopColor="hsl(var(--primary))" stopOpacity="0" />
          </radialGradient>
          <filter id="loop-soft" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.5" />
          </filter>
        </defs>

        {/* The floor: a soft glow that makes the centre read as the point everything returns to. */}
        <circle cx={CX} cy={CY} r={R + 26} fill="url(#loop-glow)" className="loop-breathe" />

        {/* The orbit itself, dashed so the direction of travel is visible even when still. */}
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="url(#loop-stroke)" strokeWidth="1.5" strokeDasharray="5 7" opacity="0.55" className="loop-orbit" />

        {/* The pulse: a short bright arc that travels the orbit. Drawn with a dash of the orbit's
            own length and moved by offset, which is the technique an SVG animator exports. */}
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="hsl(var(--primary))" strokeWidth="3.5" strokeLinecap="round" pathLength="100" strokeDasharray="9 91" className="loop-pulse" filter="url(#loop-soft)" />

        {/* The centre: what the loop produces. A verified mark, because "approved and proven" is the
            output every other stage exists for. */}
        <g className="loop-centre">
          <circle cx={CX} cy={CY} r="34" fill="hsl(var(--card))" stroke="hsl(var(--success))" strokeWidth="2" />
          <path d={`M${CX - 12} ${CY + 1} l8 8 l17 -18`} fill="none" stroke="hsl(var(--success))" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" className="loop-tick" pathLength="100" />
          <text x={CX} y={CY + 52} textAnchor="middle" fontSize="11" fontWeight="700" fill="hsl(var(--muted-foreground))" letterSpacing="0.08em">
            VERIFIED
          </text>
        </g>

        {/* The five nodes. Each breathes on its own delay so the ring reads as alive rather than as
            one thing scaling. */}
        {NODES.map((node, i) => {
          const { x, y } = pos(node.angle);
          return (
            <g key={node.key} className="loop-node" style={{ ["--i" as string]: i }}>
              <circle cx={x} cy={y} r="17" fill="hsl(var(--card))" stroke={TONE[node.tone]} strokeWidth="2.5" />
              <circle cx={x} cy={y} r="6" fill={TONE[node.tone]} />
              <text
                x={x}
                y={y + (node.angle > 0 && node.angle < 180 ? 34 : -26)}
                textAnchor="middle"
                fontSize="12"
                fontWeight="700"
                fill="hsl(var(--foreground))"
              >
                {node.label}
              </text>
            </g>
          );
        })}
      </svg>

      <style>{`
        .product-loop .loop-tick { stroke-dasharray: 100; stroke-dashoffset: 0; }
        /* One rule stops every animation in the drawing; see the note in the component. */
        .product-loop[data-loop-playing="false"] * { animation-play-state: paused !important; }
        @media (prefers-reduced-motion: no-preference) {
          .product-loop .loop-pulse { animation: loop-travel 6s cubic-bezier(.45,.05,.55,.95) infinite; }
          .product-loop .loop-breathe { animation: loop-glow 6s ease-in-out infinite; }
          .product-loop .loop-node { animation: loop-node 6s ease-in-out infinite; animation-delay: calc(var(--i) * -1.2s); }
          .product-loop .loop-tick { animation: loop-draw 6s ease-out infinite; }
          .product-loop .loop-centre { animation: loop-glow 6s ease-in-out infinite; }
        }
        /* ── NOTHING HERE ANIMATES A TRANSFORM, AND THAT IS THE WHOLE POINT ──────────────────────
           These five nodes used to breathe by scaling. A transform on an SVG node is not something
           the compositor can take: Blink lays the subtree out again on every frame. Measured with
           CDP on an idle landing page, this one small drawing was costing 119 layouts and 119 style
           recalculations PER SECOND — and it kept costing them for as long as the tab was open.
           Turning just these five off took the page's layout count to zero, which is how the cause
           was identified rather than guessed.

           opacity is composited, so the same sense of a pulse travelling the loop costs nothing
           measurable. stroke-dashoffset (the travelling pulse and the tick) was measured and does
           NOT force layout, so it stays exactly as it was — it is the motion that carries meaning
           here, and it was never the expensive part. */
        @keyframes loop-travel { from { stroke-dashoffset: 100; } to { stroke-dashoffset: 0; } }
        @keyframes loop-glow { 0%, 100% { opacity: 0.75; } 50% { opacity: 1; } }
        @keyframes loop-node { 0%, 100% { opacity: 0.72; } 20% { opacity: 1; } 55% { opacity: 0.72; } }
        @keyframes loop-draw { 0% { stroke-dashoffset: 100; } 18% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: 0; } }
      `}</style>
    </div>
  );
}
