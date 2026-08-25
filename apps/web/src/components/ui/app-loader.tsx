import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { Strands } from "./strands";

/**
 * WHAT: the application's loading state — the Strands animation over a themed ground, with a line
 * of text saying what is being waited for.
 *
 * WHY THE APP NEEDED ONE: there was no app-wide loader. Route transitions fell back to a stack of
 * grey skeleton bars that matched no real page, so every lazy route flashed a layout that was
 * about to be replaced by a different one.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT REPLACE ───────────────────────────────────────────────────
 *
 * The in-card `<Skeleton>`s stay exactly where they are. A skeleton is the right thing when the
 * PAGE is already on screen and one card is still filling in — it holds the layout and shows where
 * the content will land. This is for the other case: nothing is on screen yet and there is no
 * layout to hold. Swapping every skeleton for an animation would be slower, busier, and would lose
 * the one thing skeletons are good at.
 *
 * ── THEME ─────────────────────────────────────────────────────────────────────────────────────
 *
 * The strand palette is read from the resolved theme rather than hard-coded, because the same
 * three hexes cannot work on both grounds: on white the cyan disappears and on near-black the
 * orange glares. Light gets deeper, denser colour; dark gets the brighter, more saturated set the
 * effect was designed around. Resolved from the DOM (`documentElement.classList`) rather than from
 * a media query, so an explicit in-app theme choice wins over the OS — which is how the rest of
 * this app decides, and a loader disagreeing with the page it precedes is a visible flicker.
 */

/**
 * Tuned per ground rather than shared. The light set is darker and less luminous than the dark set
 * — a glow additively composited toward white is nearly invisible on a white page, so the light
 * palette leans on hue contrast instead of brightness.
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
    // The loader can outlive a theme toggle (a slow route, someone flipping the switch), so the
    // class is observed rather than read once. Cheap: one attribute on one element.
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
   * `page` fills its container — the route-level fallback.
   * `screen` covers the viewport — first paint, before any layout exists.
   */
  variant?: "page" | "screen";
  className?: string;
}

export function AppLoader({ label = "Loading…", variant = "page", className }: AppLoaderProps) {
  const theme = useResolvedTheme();

  return (
    <div
      // `role=status` + `aria-live=polite` so a screen reader is told the app is working. The
      // canvas itself is aria-hidden — an animation has nothing to announce.
      role="status"
      aria-live="polite"
      className={cn(
        "relative isolate grid place-items-center overflow-hidden bg-background",
        variant === "screen" ? "fixed inset-0 z-50" : "min-h-[60vh] w-full rounded-lg",
        className
      )}
    >
      {/* Painted UNDER the canvas so the loader still reads as deliberate when WebGL is
          unavailable or the context is refused — see strands.tsx, which returns quietly rather
          than throwing. Without this the fallback would be a blank rectangle. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-70 [background:radial-gradient(60%_50%_at_50%_45%,hsl(var(--primary)/0.18),transparent_70%)]"
      />

      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <Strands
          colors={[...PALETTES[theme]]}
          count={5}
          speed={0.9}
          amplitude={0.8}
          waviness={1.5}
          thickness={0.5}
          glow={2.6}
          taper={3.5}
          spread={1.5}
          // Pulled back on light, where the same exposure washes the ribbons out into the page.
          intensity={theme === "dark" ? 0.65 : 0.5}
          saturation={1.5}
          opacity={theme === "dark" ? 1 : 0.85}
          scale={1.4}
        />
      </div>

      <p className="z-10 px-6 text-center text-sm font-semibold text-muted-foreground">{label}</p>
    </div>
  );
}
