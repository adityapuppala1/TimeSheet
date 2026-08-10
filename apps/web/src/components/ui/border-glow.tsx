/**
 * WHAT: the frame every AI surface sits in — a card whose border lights up with a mesh-gradient
 * glow that follows the pointer along the edges, with an optional intro sweep when a result
 * lands. Local implementation of reactbits.dev's BorderGlow (per this repo's rule: reactbits
 * patterns are implemented in-tree against our theme tokens, never vendored as a dependency).
 *
 * WHERE IT BELONGS in the AI grammar (see index.css's AI effect layer): BorderGlow frames a
 * surface where AI is invoked or where its answer is shown. `.ai-glow` still means "the model
 * is working on this box right now"; `.ai-strand` still means "waiting for the answer". The
 * three compose: a panel is a BorderGlow, shows strands while pending, and sweeps when done.
 *
 * THEME: everything color-related lives in border-glow.css as `hsl(var(--token))` expressions,
 * so light/dark adapt automatically and instantly on theme switch — the ONE thing passed from
 * JS is the trio of mesh hues, which are mid-lightness and legible on both themes.
 */
import { useCallback, useEffect, useRef } from "react";
import { cn } from "../../lib/utils";
import "./border-glow.css";

const GRADIENT_POSITIONS = ["80% 55%", "69% 34%", "8% 6%", "41% 38%", "86% 85%", "82% 18%", "51% 4%"];
const GRADIENT_KEYS = [
  "--gradient-one",
  "--gradient-two",
  "--gradient-three",
  "--gradient-four",
  "--gradient-five",
  "--gradient-six",
  "--gradient-seven"
];
const COLOR_MAP = [0, 1, 2, 0, 1, 2, 1];

function buildGradientVars(colors: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (let i = 0; i < 7; i += 1) {
    const color = colors[Math.min(COLOR_MAP[i], colors.length - 1)];
    vars[GRADIENT_KEYS[i]] = `radial-gradient(at ${GRADIENT_POSITIONS[i]}, ${color} 0px, transparent 50%)`;
  }
  vars["--gradient-base"] = `linear-gradient(${colors[0]} 0 100%)`;
  return vars;
}

function easeOutCubic(x: number) {
  return 1 - Math.pow(1 - x, 3);
}
function easeInCubic(x: number) {
  return x * x * x;
}

function animateValue(opts: {
  start?: number;
  end?: number;
  duration: number;
  delay?: number;
  ease?: (x: number) => number;
  onUpdate: (value: number) => void;
  onEnd?: () => void;
}) {
  const { start = 0, end = 100, duration, delay = 0, ease = easeOutCubic, onUpdate, onEnd } = opts;
  let cancelled = false;
  const t0 = performance.now() + delay;
  function tick() {
    if (cancelled) return;
    const elapsed = performance.now() - t0;
    const t = Math.min(Math.max(elapsed / duration, 0), 1);
    onUpdate(start + (end - start) * ease(t));
    if (t < 1) requestAnimationFrame(tick);
    else onEnd?.();
  }
  const timer = setTimeout(() => requestAnimationFrame(tick), delay);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

export function BorderGlow({
  children,
  className,
  animated = false,
  colors = ["#c084fc", "#f472b6", "#38bdf8"],
  edgeSensitivity = 30,
  coneSpread = 25
}: {
  children: React.ReactNode;
  className?: string;
  /** Play the intro sweep on mount — key the component by the result's identity so a fresh
   *  answer sweeps again. */
  animated?: boolean;
  /** Three mesh hues. The defaults read on both themes; only override with equally
   *  mid-lightness colors. */
  colors?: string[];
  edgeSensitivity?: number;
  coneSpread?: number;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const dx = x - cx;
    const dy = y - cy;

    // Edge proximity: 0 at center, 1 at the border, on whichever axis is closest to leaving.
    const kx = dx !== 0 ? cx / Math.abs(dx) : Infinity;
    const ky = dy !== 0 ? cy / Math.abs(dy) : Infinity;
    const edge = Math.min(Math.max(1 / Math.min(kx, ky), 0), 1);
    let angle = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
    if (angle < 0) angle += 360;

    card.style.setProperty("--edge-proximity", (edge * 100).toFixed(3));
    card.style.setProperty("--cursor-angle", `${angle.toFixed(3)}deg`);
  }, []);

  useEffect(() => {
    const card = cardRef.current;
    if (!animated || !card) return;
    // The sweep is decoration; anyone who asked the OS for less motion gets none of it —
    // matching how index.css switches off the rest of the AI effect layer.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const angleStart = 110;
    const angleEnd = 465;
    card.classList.add("sweep-active");
    card.style.setProperty("--cursor-angle", `${angleStart}deg`);
    const setAngle = (v: number) =>
      card.style.setProperty("--cursor-angle", `${(angleEnd - angleStart) * (v / 100) + angleStart}deg`);

    const cancels = [
      animateValue({ duration: 500, onUpdate: (v) => card.style.setProperty("--edge-proximity", String(v)) }),
      animateValue({ ease: easeInCubic, duration: 1500, end: 50, onUpdate: setAngle }),
      animateValue({ ease: easeOutCubic, delay: 1500, duration: 2250, start: 50, end: 100, onUpdate: setAngle }),
      animateValue({
        ease: easeInCubic,
        delay: 2500,
        duration: 1500,
        start: 100,
        end: 0,
        onUpdate: (v) => card.style.setProperty("--edge-proximity", String(v)),
        onEnd: () => card.classList.remove("sweep-active")
      })
    ];
    return () => {
      cancels.forEach((cancel) => cancel());
      card.classList.remove("sweep-active");
    };
  }, [animated]);

  return (
    <div
      ref={cardRef}
      onPointerMove={handlePointerMove}
      className={cn("border-glow-card", className)}
      style={
        {
          "--edge-sensitivity": edgeSensitivity,
          "--cone-spread": coneSpread,
          ...buildGradientVars(colors)
        } as React.CSSProperties
      }
    >
      <span className="border-glow-edge" aria-hidden />
      <div className="border-glow-inner">{children}</div>
    </div>
  );
}
