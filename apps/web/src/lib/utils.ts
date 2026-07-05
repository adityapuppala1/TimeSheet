/**
 * WHAT: `cn()` — the standard shadcn-style classnames helper (clsx + tailwind-merge).
 * WHY: `clsx` handles conditional/array class logic; `tailwind-merge` then resolves
 * conflicting Tailwind utility classes (e.g. a caller-supplied `p-2` overriding a
 * component's default `p-4`) by keeping only the last one that wins, rather than emitting
 * both and letting CSS cascade order decide unpredictably.
 * WHO calls this: nearly every component in `components/ui/*` and every page, wherever a
 * className is conditionally composed.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

