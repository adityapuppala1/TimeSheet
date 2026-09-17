import { useEffect, useRef, useState } from "react";

/**
 * V12 10.2 — the one place that answers "may this animate", and the one counter that rolls.
 *
 * WHY THIS FILE EXISTS: `usePrefersReducedMotion` had been written FIVE times, byte for byte, and
 * `useCountUp` four. Every copy was correct on the day it was written, which is exactly how a set
 * of copies drifts: the sixth call site copies whichever one it happened to sit next to, and a
 * person who asked their operating system for less motion gets it on four screens out of five.
 *
 * The marketing pages keep their own count-ups on purpose — those are keyed to an intersection
 * observer and return a formatted string, so folding them in here would be a rewrite, not a
 * consolidation.
 */

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

/** Live, not read-once: somebody can change the setting with the app open, and the next frame
 *  should respect it. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCE_QUERY).matches
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCE_QUERY);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

export const COUNT_UP_DURATION_MS = 450;

/**
 * One frame of a rolling counter, as a pure function of elapsed time.
 *
 * Eased rather than linear so it decelerates into the figure — a linear count reads as a spinner.
 * At or past the end it returns the TARGET itself, never the interpolation: a counter that settles
 * on 153 when the answer is 154 is a bug that only appears on a slow machine.
 */
export function countUpFrame(from: number, to: number, elapsedMs: number, durationMs = COUNT_UP_DURATION_MS): number {
  if (durationMs <= 0 || elapsedMs >= durationMs) return to;
  if (elapsedMs <= 0) return from;
  const t = elapsedMs / durationMs;
  const eased = 1 - Math.pow(1 - t, 3);
  return Math.round(from + (to - from) * eased);
}

/** Rolls a number to its new value. `disabled` short-circuits to the value itself — pass the
 *  reduced-motion answer, or `true` wherever a rolling number would be noise. */
export function useCountUp(value: number, disabled: boolean): number {
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);

  useEffect(() => {
    if (disabled) {
      fromRef.current = value;
      setShown(value);
      return;
    }
    const from = fromRef.current;
    if (from === value) return;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const next = countUpFrame(from, value, now - start);
      setShown(next);
      if (next === value && now - start >= COUNT_UP_DURATION_MS) {
        fromRef.current = value;
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, disabled]);

  return shown;
}

/** How long a list may keep staggering before it stops feeling alive and starts feeling slow. */
export const STAGGER_STEP_MS = 28;
export const STAGGER_MAX_STEPS = 12;

/**
 * The inline delay for the nth item of a staggered list, capped.
 *
 * Uncapped, the 60th card on a board would wait nearly two seconds to appear — which is not
 * "arriving", it is "missing". Past the cap every remaining item shares the last delay.
 */
export function staggerStyle(index: number): { ["--stagger-delay"]: string } {
  const step = Math.min(Math.max(index, 0), STAGGER_MAX_STEPS);
  return { ["--stagger-delay"]: `${step * STAGGER_STEP_MS}ms` };
}
