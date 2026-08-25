import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { Strands } from "./strands";

/**
 * WHAT: the application's loading state — the Strands animation with a line of text under it,
 * centred in whatever space it is given. THE loader: `layouts/AppLayout.tsx` shows it while the
 * session hydrates and `App.tsx`'s PageShell shows it while a lazy route resolves, so a refresh
 * that crosses both gates shows one consistent thing rather than two different ones.
 *
 * WHY NO CARD AND NO SCRIM: it went through both and neither was right. Full-bleed strands read as
 * a background effect rather than a loader; a bordered panel on a blurred backdrop read as a modal
 * that had lost its buttons. An application loader is a mark and a label on the page background,
 * which is what this is.
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
        // Solid page background, not a translucent scrim. A backdrop-blur veil belongs to a modal
        // over content the user was already looking at; a loader has nothing behind it to veil, and
        // the frosted panel made it read as an overlay stuck on top of the app.
        variant === "screen" ? "fixed inset-0 z-50 bg-background" : "min-h-[50vh] w-full",
        className
      )}
    >
      {/* The animation sits directly on the page — no card, no border, no shadow. An application
          loader is a mark and a line of text, the way this one is now; the bounded panel looked
          like a dialog that had lost its buttons. */}
      <div className="relative isolate flex h-40 w-full max-w-sm flex-col items-center justify-center">

        {/* Mounted only once the load has proven slow enough to be worth animating — see
            ANIMATE_AFTER_MS. Until then the label alone carries the loader. */}
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

        {/* The strands concentrate in the vertical middle, so the label sits below them rather than
            on top — no scrim needed once it is out of the bright band, and a plain line of text is
            what an app loader looks like. */}
        <p className="absolute inset-x-0 -bottom-2 z-10 text-center text-sm font-medium text-muted-foreground">
          {label}
        </p>
      </div>
    </div>
  );
}
