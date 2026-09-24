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

/**
 * Tailwind's `sm` breakpoint (640px) as a question: does this viewport get the CARD list instead
 * of the table?
 *
 * WHY IT IS WORTH A HOOK RATHER THAN `sm:hidden` / `hidden sm:block`, which is what every list in
 * this app used before: those classes do not stop React rendering the other branch, they only stop
 * the browser painting it. Measured on /app/tickets at 1366px — 9,267 elements on the page, 7,144
 * of them (77%) inside a `display:none` card list nobody could see. A phone paid the mirror image,
 * rendering the full table it would never show. The invisible half is not free: Radix's dialog
 * walks the whole document to set `aria-hidden` when it opens and again to undo it on close, so
 * opening "New ticket" cost 264ms and closing it 280ms; with the list filtered down to one row
 * those fell to 184ms and 168ms. Style, layout and the accessibility tree all scale with the tree
 * that exists, not the tree that is visible.
 *
 * The rule this follows is the one in useMediaQuery above, applied where it was being broken: CSS
 * for cheap markup, JS when the two branches are whole component trees.
 *
 * Both branches stay in the source and stay in sync on data — only one of them mounts.
 */
export function useCardLayout(): boolean {
  return !useMediaQuery("(min-width: 640px)");
}
