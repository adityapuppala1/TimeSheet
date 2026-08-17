/**
 * A CSS media query as React state, kept current as the viewport changes.
 *
 * WHY THIS EXISTS RATHER THAN A TAILWIND CLASS: `hidden md:block` is the right answer whenever
 * both branches are cheap markup — it needs no JS and no re-render. It is the wrong answer when
 * the two branches are *different components*, because both would mount: two charts computing
 * layout, two `ResponsiveContainer`s measuring, one of them permanently invisible. The dashboard's
 * project chart switches FORM at a breakpoint (horizontal bars ↔ donut), so it needs to know the
 * width in JS and render one of them.
 *
 * The listener matters as much as the initial read: a laptop user dragging a window across the
 * breakpoint, or a phone rotating, must get the other form — a value sampled once at mount would
 * leave the wrong chart on screen until a remount that may never come.
 */
import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    // Guarded for SSR and for jsdom-style environments without matchMedia; `false` is the safe
    // default because every caller treats it as "the narrower/simpler branch".
    () => typeof window !== "undefined" && window.matchMedia?.(query).matches === true
  );

  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const onChange = () => setMatches(list.matches);
    // Re-read on subscribe: between the initial state and this effect, the viewport may already
    // have changed (a hydration mismatch, or a resize during mount).
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
