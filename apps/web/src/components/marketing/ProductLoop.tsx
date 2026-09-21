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
  return (
    <div className={cn("product-loop", className)} aria-hidden={compact ? undefined : false}>
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
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="hsl(var(--info))" strokeWidth="2" strokeLinecap="round" pathLength="100" strokeDasharray="9 91" className="loop-pulse" />

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
            <g key={node.key} className="loop-node" style={{ ["--i" as string]: i, transformOrigin: `${x}px ${y}px` }}>
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
        @media (prefers-reduced-motion: no-preference) {
          .product-loop .loop-orbit { animation: loop-spin 40s linear infinite; transform-origin: ${CX}px ${CY}px; }
          .product-loop .loop-pulse { animation: loop-travel 6s cubic-bezier(.45,.05,.55,.95) infinite; }
          .product-loop .loop-breathe { animation: loop-breathe 6s ease-in-out infinite; transform-origin: ${CX}px ${CY}px; }
          .product-loop .loop-node { animation: loop-node 6s ease-in-out infinite; animation-delay: calc(var(--i) * -1.2s); }
          .product-loop .loop-tick { animation: loop-draw 6s ease-out infinite; }
          .product-loop .loop-centre { animation: loop-breathe 6s ease-in-out infinite; transform-origin: ${CX}px ${CY}px; }
        }
        @keyframes loop-spin { to { transform: rotate(360deg); } }
        @keyframes loop-travel { from { stroke-dashoffset: 100; } to { stroke-dashoffset: 0; } }
        @keyframes loop-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }
        @keyframes loop-node { 0%, 100% { transform: scale(1); } 20% { transform: scale(1.12); } 40% { transform: scale(1); } }
        @keyframes loop-draw { 0% { stroke-dashoffset: 100; } 18% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: 0; } }
      `}</style>
    </div>
  );
}
