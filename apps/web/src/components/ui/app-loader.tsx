import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { Strands } from "./strands";

/**
 * WHAT: the application's loading state — a CONTAINED panel with the Strands animation and a line
 * of text, centred in whatever space it is given.
 *
 * WHY CONTAINED, NOT FULL-BLEED: an earlier version washed the whole viewport in strands, which
 * read as a background effect rather than a loader and swamped the page. This draws the animation
 * inside a bounded card — a thing that is recognisably "the app is loading", the same shape and
 * footprint whether it stands in for a route or covers first paint.
 *
 * WHAT IT DELIBERATELY DOES NOT REPLACE: the in-card `<Skeleton>`s. A skeleton is right when the
 * PAGE is already on screen and one card is filling in — it holds the layout. This is for the
 * other case, where nothing is on screen and there is no layout to hold.
 *
 * THEME: the strand palette is read from the resolved theme, because the same hexes cannot work on
 * both grounds — a glow composited toward white is nearly invisible on a white panel. Resolved
 * from `documentElement.classList` (how the rest of the app decides) and observed, so a toggle
 * mid-load is followed.
 */

/**
 * Per-ground palettes. Light is deeper and less luminous — it leans on hue contrast because
 * brightness barely registers on a pale panel; dark gets the brighter, more saturated set.
 */
const PALETTES = {
  light: ["#0A7B87", "#7C3AED", "#EA580C"],
  dark: ["#22D3EE", "#A78BFA", "#F97316"]
} as const;

function useResolvedTheme(): "light" | "dark" {
  const read = () =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light";

  const [theme, setTheme] = useState<"light" | "dark">(read);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}

export interface AppLoaderProps {
  /** What is being waited for. Shown under the animation. */
  label?: string;
  /**
   * `page` centres the panel in its container — the route-level fallback.
   * `screen` covers the viewport and centres the same panel — first paint, before any layout.
   */
  variant?: "page" | "screen";
  className?: string;
}

/**
 * How long a load must last before the animation is worth starting.
 *
 * Most route transitions in this app resolve in well under this, and for those the loader shows
 * its card and its label and never touches WebGL at all. That matters for three reasons: a GL
 * context spun up and torn down inside 100ms is pure cost, a flash of animation on a fast
 * navigation is worse UX than a still card, and it keeps the app off the GPU entirely on machines
 * that do not have one — headless CI included, where every page renders through this fallback.
 */
const ANIMATE_AFTER_MS = 250;

export function AppLoader({ label = "Loading…", variant = "page", className }: AppLoaderProps) {
  const theme = useResolvedTheme();
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setAnimate(true), ANIMATE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      // `role=status` + `aria-live=polite` so a screen reader is told the app is working. The
      // canvas itself is aria-hidden — an animation has nothing to announce.
      role="status"
      aria-live="polite"
      className={cn(
        "grid place-items-center",
        variant === "screen" ? "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" : "min-h-[50vh] w-full",
        className
      )}
    >
      {/* THE LOADER ITSELF: a bounded card, not a full-bleed background. */}
      <div className="relative isolate flex h-56 w-full max-w-md flex-col items-center justify-center overflow-hidden rounded-2xl border border-border bg-card shadow-lg">
        {/* A themed gradient under the canvas so the panel still reads as deliberate when WebGL is
            unavailable or the context is refused — Strands returns quietly rather than throwing. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 [background:radial-gradient(70%_60%_at_50%_45%,hsl(var(--primary)/0.14),transparent_75%)]"
        />

        {/* Mounted only once the load has proven slow enough to be worth animating — see
            ANIMATE_AFTER_MS. Until then the card, its gradient and its label carry the loader. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          {animate && (
          <Strands
            colors={[...PALETTES[theme]]}
            count={3}
            speed={0.9}
            amplitude={0.6}
            waviness={2}
            thickness={0.4}
            glow={2.6}
            taper={2.1}
            spread={1.4}
            // Pulled back on light, where the same exposure washes the ribbons out into the panel.
            intensity={theme === "dark" ? 0.6 : 0.5}
            saturation={1.5}
            opacity={theme === "dark" ? 1 : 0.9}
            scale={1.5}
          />
          )}
        </div>

        {/* The strands concentrate in the vertical centre, so the label sits at the BOTTOM of the
            panel with a small scrim behind it — otherwise "Loading…" is drawn straight over the
            brightest part of the animation and cannot be read. */}
        <p className="absolute inset-x-0 bottom-4 z-10 mx-auto w-fit max-w-[90%] rounded-full bg-card/80 px-3 py-1 text-center text-sm font-semibold text-foreground/80 backdrop-blur-sm">
          {label}
        </p>
      </div>
    </div>
  );
}
