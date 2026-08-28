/**
 * A light travelling along a curve between two elements. Local implementation of magicui's
 * animated-beam, per this repo's rule that such patterns are built in-tree against our own theme
 * tokens rather than vendored — same reasoning as BorderGlow (see ui/border-glow.tsx).
 *
 * HOW IT WORKS: one absolutely-positioned SVG covering the container, and a quadratic curve from
 * the centre of `fromRef` to the centre of `toRef`. Two paths are drawn on top of each other — a
 * faint static one so the connection is visible at rest, and a bright one whose stroke is a
 * gradient that slides along the curve.
 *
 * WHY THE GRADIENT MOVES AND NOT THE PATH: animating `x1/x2` on a `linearGradient` is a paint the
 * browser can do without touching layout or style on any DOM element outside this SVG. The obvious
 * alternative — animating `stroke-dashoffset` — invalidates style on the path every frame, and on
 * a page with a dozen of these that is exactly the cost that made the app's own AI labels the
 * single most expensive thing in the product (see `.ai-gradient-text` in index.css, where the
 * measurements are written down). This effect is decorative; it does not get to cost that.
 *
 * GEOMETRY IS MEASURED, NOT ASSUMED. The endpoints come from `getBoundingClientRect` against the
 * container, recomputed on resize via a ResizeObserver on both the container and the endpoints, so
 * the beams stay attached when the layout reflows — which it does at every breakpoint here.
 *
 * REDUCED MOTION: the static path stays and the gradient stops. The diagram is information (what
 * this product connects to); the travelling light is not.
 */
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";

export interface AnimatedBeamProps {
  containerRef: RefObject<HTMLElement | null>;
  fromRef: RefObject<HTMLElement | null>;
  toRef: RefObject<HTMLElement | null>;
  /** Positive bows the curve downward, negative upward. 0 is a straight line. */
  curvature?: number;
  /** Travel from `to` to `from` instead. */
  reverse?: boolean;
  /** Seconds for one pass. */
  duration?: number;
  /** Seconds before the first pass — stagger these so the beams don't pulse in lockstep. */
  delay?: number;
  startYOffset?: number;
  endYOffset?: number;
  className?: string;
}

export function AnimatedBeam({
  containerRef,
  fromRef,
  toRef,
  curvature = 0,
  reverse = false,
  duration = 3,
  delay = 0,
  startYOffset = 0,
  endYOffset = 0,
  className = ""
}: AnimatedBeamProps) {
  const id = useId().replace(/:/g, "");
  const [path, setPath] = useState("");
  const [box, setBox] = useState({ width: 0, height: 0 });
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }, []);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const from = fromRef.current;
    const to = toRef.current;
    if (!container || !from || !to) return;

    const c = container.getBoundingClientRect();
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();

    setBox({ width: c.width, height: c.height });

    const x1 = a.left - c.left + a.width / 2;
    const y1 = a.top - c.top + a.height / 2 + startYOffset;
    const x2 = b.left - c.left + b.width / 2;
    const y2 = b.top - c.top + b.height / 2 + endYOffset;
    // Control point at the midpoint, pushed perpendicular-ish by `curvature`. Good enough for a
    // decorative arc and far cheaper to reason about than a real cubic.
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2 - curvature;

    setPath(`M ${x1},${y1} Q ${cx},${cy} ${x2},${y2}`);
  }, [containerRef, fromRef, toRef, curvature, startYOffset, endYOffset]);

  useEffect(() => {
    measure();
    const observer = new ResizeObserver(() => measure());
    for (const el of [containerRef.current, fromRef.current, toRef.current]) {
      if (el) observer.observe(el);
    }
    // Endpoints can also move without resizing — a font swap, a scrollbar appearing — so a window
    // listener backs the observer up.
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, containerRef, fromRef, toRef]);

  if (!path) return null;

  return (
    <svg
      fill="none"
      width={box.width}
      height={box.height}
      viewBox={`0 0 ${box.width} ${box.height}`}
      className={`pointer-events-none absolute left-0 top-0 ${className}`}
      aria-hidden
      focusable="false"
    >
      {/* The resting connection. Without it the diagram is a set of disconnected circles between
          pulses, which reads as broken rather than as calm. */}
      <path d={path} stroke="hsl(var(--border))" strokeWidth={1.5} strokeOpacity={0.9} strokeLinecap="round" />
      <path d={path} strokeWidth={2} stroke={`url(#${id})`} strokeOpacity={1} strokeLinecap="round" />
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0%" x2="0%" y1="0%" y2="0%">
          {/* Transparent at both ends so the bright middle reads as a travelling packet rather than
              as the whole line changing colour. */}
          <stop stopColor="hsl(var(--primary))" stopOpacity="0" />
          <stop stopColor="hsl(var(--primary))" />
          <stop offset="32.5%" stopColor="hsl(var(--info))" />
          <stop offset="100%" stopColor="hsl(var(--info))" stopOpacity="0" />
          {!reduced.current && (
            <>
              <animate
                attributeName="x1"
                values={reverse ? "90%;-10%" : "-10%;110%"}
                dur={`${duration}s`}
                begin={`${delay}s`}
                repeatCount="indefinite"
              />
              <animate
                attributeName="x2"
                values={reverse ? "110%;10%" : "0%;120%"}
                dur={`${duration}s`}
                begin={`${delay}s`}
                repeatCount="indefinite"
              />
            </>
          )}
        </linearGradient>
      </defs>
    </svg>
  );
}
