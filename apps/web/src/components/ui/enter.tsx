import type { CSSProperties, ElementType, HTMLAttributes } from "react";

import { cn } from "../../lib/utils";

/**
 * A staggered entrance — fade up 14px — in CSS (the `enter` keyframe in src/index.css).
 *
 * Replaces the framer-motion `initial/animate/transition` entrances (removed 2026-10-06, ~39 KB gzipped
 * that the Dashboard and the sign-in recovery pages loaded for exactly this). `motion-safe:` means a
 * visitor who asked for reduced motion sees the element in place immediately, and `both` fill mode
 * keeps it hidden during its own delay so a stagger reads as one.
 */
export function Enter({
  as: Tag = "div",
  delay = 0,
  duration,
  className,
  style,
  ...rest
}: { as?: ElementType; delay?: number; duration?: number; className?: string; style?: CSSProperties } & HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn("motion-safe:animate-enter", className)}
      style={{ animationDelay: `${delay}s`, ...(duration ? { animationDuration: `${duration}s` } : {}), ...style }}
      {...rest}
    />
  );
}
