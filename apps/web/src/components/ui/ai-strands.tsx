/**
 * WHAT: the "AI is working" indicator — a few interweaving strands with light flowing along them,
 * shown between asking the model something and its answer arriving.
 *
 * WHY STRANDS AND NOT A SPINNER: a spinner promises "any moment now" and starts to read as broken
 * past a couple of seconds. Model calls routinely take five to fifteen, and flowing strands read
 * as "something is being worked through" rather than "something is stuck" — the same reasoning
 * that gave AiRefine its writing-itself shimmer lines for text specifically.
 *
 * ACCESSIBILITY: the SVG is decoration (aria-hidden); the label is the accessible content, inside
 * a polite live region so the state change is announced once. Under prefers-reduced-motion the
 * flow animation is switched off in CSS (index.css, `.ai-strand`) and the static strands plus the
 * sentence still say what is happening — nothing is lost but the movement.
 *
 * The animation itself lives in index.css with the rest of the AI effect layer so the timing and
 * reduced-motion handling stay in one place.
 */
import { cn } from "../../lib/utils";

/** Four paths across one 120×32 box, weaving around the midline. Opacity steps per strand keep
 *  them distinguishable while staying one hue — the same single-hue-by-alpha technique the charts
 *  use for ordered series. */
const STRANDS = [
  { d: "M0 16 C 20 4, 40 28, 60 16 S 100 4, 120 16", opacity: 0.35 },
  { d: "M0 16 C 20 28, 40 6, 60 18 S 100 26, 120 16", opacity: 0.55 },
  { d: "M0 16 C 28 10, 48 24, 68 12 S 104 20, 120 16", opacity: 0.75 },
  { d: "M0 16 C 24 22, 46 8, 66 20 S 100 10, 120 16", opacity: 1 }
] as const;

export function AiStrands({ label, className }: { label: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn("flex items-center gap-3", className)}>
      <svg viewBox="0 0 120 32" className="h-8 w-28 shrink-0" aria-hidden="true">
        {STRANDS.map((strand, index) => (
          <path
            key={strand.d}
            className="ai-strand"
            d={strand.d}
            fill="none"
            stroke={`hsl(var(--primary) / ${strand.opacity})`}
            strokeWidth={1.75}
            strokeLinecap="round"
            style={{ animationDelay: `${index * 0.3}s` }}
          />
        ))}
      </svg>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
