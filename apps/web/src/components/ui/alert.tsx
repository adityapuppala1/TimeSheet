import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";

// `min-w-0 break-words` is load-bearing, not tidying. An alert is almost always a grid/flex item,
// and such an item's automatic minimum size is its MIN-CONTENT — so an alert quoting an env var,
// a URL or a stack trace pushes its whole page wider than the viewport on a phone, dragging every
// sibling out with it. `min-w-0` lets the box shrink to the track; `break-words` then wraps the
// long token inside it instead of letting it hang out over the edge. Alerts are exactly where
// unbreakable machine text (hosts, ports, file paths, error strings) shows up, so this belongs on
// the primitive rather than being rediscovered per page.
const alertVariants = cva(
  "relative w-full min-w-0 break-words rounded-lg border px-4 py-3 text-sm [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg~*]:pl-7 [&>svg]:h-4 [&>svg]:w-4",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        info: "border-info/30 bg-info/10 text-info [&>svg]:text-info",
        success: "border-success/30 bg-success/10 text-success [&>svg]:text-success",
        warning: "border-warning/40 bg-warning/10 text-warning [&>svg]:text-warning",
        destructive: "border-destructive/40 bg-destructive/10 text-destructive [&>svg]:text-destructive"
      }
    },
    defaultVariants: { variant: "default" }
  }
);

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {
  /**
   * Pass a handler to make the alert closable. The button inherits the variant's colour through
   * `currentColor`, so a destructive alert gets a red X and an info alert a blue one without any
   * per-variant styling here.
   *
   * WHY THE CALLER OWNS THE STATE rather than the alert hiding itself: whether a dismissal should
   * last a session, a day, or until the underlying situation changes is a question about the
   * MESSAGE, not about the box it is drawn in. The daily-log banner should return tomorrow; a
   * banner about a specific set of tickets should return when that set changes. An alert that
   * unmounted itself would force every caller into the same answer. See `useDismissed`.
   */
  onDismiss?: () => void;
  /** Announced to screen readers; defaults to something sensible for a notice. */
  dismissLabel?: string;
}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, onDismiss, dismissLabel = "Dismiss this notice", children, ...props }, ref) => (
    <div
      ref={ref}
      role="alert"
      // Extra right padding ONLY when the button is there, so a non-dismissible alert is not
      // silently narrowed by space reserved for a control it does not have.
      className={cn(alertVariants({ variant }), onDismiss && "pr-11", className)}
      {...props}
    >
      {children}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          // `absolute` matches how the leading icon is positioned by alertVariants, so the button
          // sits on the alert rather than in the text flow and cannot be pushed around by a long
          // title wrapping onto a second line.
          //
          // A faint tinted chip rather than a bare icon: at opacity-60 the previous X was almost
          // invisible on the low-contrast tinted grounds these alerts use (a pale-blue X on a
          // pale-blue info banner), and people reported not seeing it. `bg-current/10` gives it a
          // just-perceptible circle in the variant's own colour, darkening on hover, so it reads as
          // a control without fighting the alert's palette.
          className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-current/10 opacity-80 transition hover:bg-current/20 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-offset-1"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  )
);
Alert.displayName = "Alert";

export const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5 ref={ref} className={cn("mb-1 font-bold leading-none tracking-tight", className)} {...props} />
  )
);
AlertTitle.displayName = "AlertTitle";

export const AlertDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-sm leading-relaxed [&_p]:leading-relaxed", className)} {...props} />
  )
);
AlertDescription.displayName = "AlertDescription";
