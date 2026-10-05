import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground",
        /* The fill is a tint of the tone; the TEXT is that tone's `ink`, which is a different
           value for a reason — see index.css. Using the fill colour as its own text put "HIGH" at
           2.09:1 on a light theme, at 10.5px. `scripts/contrast-check.mjs` now gates this pair. */
        success: "border-transparent bg-success/15 text-success-ink",
        warning: "border-transparent bg-warning/15 text-warning-ink",
        destructive: "border-transparent bg-destructive/15 text-destructive-ink",
        info: "border-transparent bg-info/15 text-info-ink",
        muted: "border-transparent bg-muted text-muted-foreground"
      }
    },
    defaultVariants: { variant: "default" }
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  // A badge given a pixel size (`text-[10px]`, 39 of them) INHERITED its parent's line height under
  // Tailwind 3 — tailwind-merge dropped `text-xs`, and an arbitrary size set no line height. Tailwind 4's
  // arbitrary sizes bring their own, so those badges came out ~3px shorter and shifted every table
  // row holding one. v3 inherited the surrounding text-sm line (1.25rem); v4 would inherit a RATIO, so
  // the 1.25rem is set outright. Badges without an override are untouched.
  const pixelSized = typeof className === "string" && /(^|\s)text-\[\d/.test(className);
  return <span className={cn(badgeVariants({ variant }), className, pixelSized && "leading-5")} {...props} />;
}
