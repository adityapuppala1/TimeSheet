/**
 * WHAT: the slide-over panel primitive, plus — for the ones that hold a whole working surface
 * rather than a short form — a WIDTH the reader controls: drag the edge, or maximize to the full
 * window and restore.
 *
 * WHY THAT IS NOT A LUXURY HERE: the ticket detail sheet is the most-used screen in the product
 * and it is where a description, a comment thread, a code block, a proofing image and a
 * twelve-column activity log all have to be read and edited. At a fixed `sm:max-w-xl` (576px) a
 * pasted stack trace wraps into unreadable ribbon, and the person triaging it cannot do the one
 * thing every other window on their desktop lets them do about that. The panel is also the thing
 * you read WHILE looking at the list behind it, so "always full width" would be the wrong default
 * — which is exactly why it is a control and not a new constant.
 *
 * The chosen width is remembered per `storageKey`, so it is set once rather than re-dragged on
 * every ticket.
 */
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { Maximize2, Minimize2, X } from "lucide-react";
import { cn } from "../../lib/utils";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetPortal = DialogPrimitive.Portal;

export const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/55 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
));
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName;

const sheetVariants = cva(
  "fixed z-50 gap-4 bg-popover p-6 shadow-xl transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b border-border data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom: "inset-x-0 bottom-0 border-t border-border data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-3/4 border-r border-border data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
        right: "inset-y-0 right-0 h-full w-3/4 border-l border-border data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm"
      }
    },
    defaultVariants: { side: "right" }
  }
);

/* ============================== Resizing ============================== */

/**
 * Below this width the sheet is already the whole screen and there is nothing to resize into —
 * so the handle, the maximize button and the stored width are all suppressed rather than offering
 * a control that cannot do anything. Matches Tailwind's `sm`.
 */
const RESIZE_MIN_VIEWPORT = 640;
/** Narrow enough to still see the list behind it; wide enough that the panel is not the page. */
const DEFAULT_WIDTH = 576;
const MIN_WIDTH = 380;

/** Live answer to "is the viewport wide enough for any of this", kept current across a rotation
 *  or a window drag rather than sampled once at mount. */
function useIsResizableViewport(): boolean {
  const [wide, setWide] = React.useState(
    () => typeof window !== "undefined" && window.innerWidth >= RESIZE_MIN_VIEWPORT
  );
  React.useEffect(() => {
    const query = window.matchMedia(`(min-width: ${RESIZE_MIN_VIEWPORT}px)`);
    const onChange = () => setWide(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return wide;
}

export interface UseSheetResizeOptions {
  /** localStorage key the chosen width is remembered under. Omit to make the size per-session. */
  storageKey?: string;
  defaultWidth?: number;
  minWidth?: number;
}

export function useSheetResize({ storageKey, defaultWidth = DEFAULT_WIDTH, minWidth = MIN_WIDTH }: UseSheetResizeOptions = {}) {
  const resizable = useIsResizableViewport();
  const [width, setWidth] = React.useState<number>(() => {
    if (typeof window === "undefined" || !storageKey) return defaultWidth;
    const stored = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored >= minWidth ? stored : defaultWidth;
  });
  const [maximized, setMaximized] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);

  /** The ceiling has to follow the window: a width dragged out on a 4K monitor must not leave the
   *  panel wider than a laptop screen when the session moves to one. */
  const clamp = React.useCallback(
    (value: number) => {
      const ceiling = typeof window === "undefined" ? value : window.innerWidth;
      return Math.min(Math.max(value, minWidth), ceiling);
    },
    [minWidth]
  );

  const commit = React.useCallback(
    (value: number) => {
      const next = clamp(value);
      setWidth(next);
      if (storageKey) window.localStorage.setItem(storageKey, String(next));
    },
    [clamp, storageKey]
  );

  /**
   * Pointer events, not mouse events: one code path covers mouse, trackpad, pen and touch, and
   * `setPointerCapture` keeps the drag alive when the pointer outruns the 6px handle — which it
   * always does. Without capture the resize stops the instant the cursor leaves the strip, which
   * reads as the handle being broken.
   */
  const onHandlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!resizable) return;
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      setDragging(true);
      setMaximized(false);

      const move = (moveEvent: PointerEvent) => {
        // The sheet is anchored to the right edge, so its width is the distance from the pointer
        // to that edge.
        setWidth(clamp(window.innerWidth - moveEvent.clientX));
      };
      const end = (endEvent: PointerEvent) => {
        handle.releasePointerCapture?.(endEvent.pointerId);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        setDragging(false);
        // Persisted once, at the end — writing localStorage on every pointermove would be a
        // synchronous disk write per frame.
        commit(window.innerWidth - endEvent.clientX);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    },
    [clamp, commit, resizable]
  );

  /** Arrow keys move the edge too. A drag handle that only answers to a pointer is a control a
   *  keyboard user simply does not have. */
  const onHandleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 100 : 20;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setMaximized(false);
        commit(width + step);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setMaximized(false);
        commit(width - step);
      } else if (event.key === "Home") {
        event.preventDefault();
        setMaximized(true);
      } else if (event.key === "End") {
        event.preventDefault();
        setMaximized(false);
        commit(defaultWidth);
      }
    },
    [commit, defaultWidth, width]
  );

  const toggleMaximize = React.useCallback(() => setMaximized((current) => !current), []);

  return {
    resizable,
    width,
    maximized,
    dragging,
    toggleMaximize,
    onHandlePointerDown,
    onHandleKeyDown,
    /** Applied to SheetContent. Undefined on a phone, where the sheet is already the whole
     *  screen and an inline width would fight the responsive classes. */
    style: resizable ? { width: maximized ? "100vw" : `${width}px`, maxWidth: "100vw" } : undefined
  };
}

export type SheetResizeState = ReturnType<typeof useSheetResize>;

/**
 * The draggable edge.
 *
 * `role="separator"` + `aria-orientation` + `tabIndex` is the WAI-ARIA **window splitter**
 * pattern — a focusable separator IS the interactive element here, which is why it carries key
 * handlers. Static-analysis rules that flag "non-interactive element with a keyboard listener"
 * are pattern-matching on the tag rather than the role; a `<button>` would be wrong (it is not a
 * button, and it has no activation behaviour), and dropping `tabIndex` would take the control
 * away from keyboard users entirely.
 */
export function SheetResizeHandle({ state, label = "Resize panel" }: Readonly<{ state: SheetResizeState; label?: string }>) {
  if (!state.resizable || state.maximized) return null;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`${label} — drag, or use the left and right arrow keys`}
      aria-valuenow={Math.round(state.width)}
      tabIndex={0}
      onPointerDown={state.onHandlePointerDown}
      onKeyDown={state.onHandleKeyDown}
      // Sits ON the border and extends a few pixels either side: a 1px target is unhittable, and
      // `touch-none` stops a touch drag from scrolling the panel instead of resizing it.
      className={cn(
        "group absolute inset-y-0 left-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize touch-none",
        "focus-visible:outline-none"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-colors",
          "group-hover:bg-primary/60 group-focus-visible:bg-primary",
          state.dragging ? "bg-primary" : "bg-transparent"
        )}
      />
    </div>
  );
}

/** Maximize / restore. Rendered next to the sheet's own close button. */
export function SheetMaximizeButton({ state }: Readonly<{ state: SheetResizeState }>) {
  if (!state.resizable) return null;
  return (
    <button
      type="button"
      onClick={state.toggleMaximize}
      aria-label={state.maximized ? "Restore panel width" : "Maximize panel to full width"}
      title={state.maximized ? "Restore" : "Maximize"}
      aria-pressed={state.maximized}
      className="focus-ring absolute right-12 top-4 z-20 rounded-sm opacity-70 transition hover:opacity-100"
    >
      {state.maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
    </button>
  );
}

export interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof sheetVariants> {}

export const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(({ side = "right", className, children, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content ref={ref} className={cn(sheetVariants({ side }), className)} {...props}>
      {children}
      <DialogPrimitive.Close className="focus-ring absolute right-4 top-4 z-20 rounded-sm opacity-70 transition hover:opacity-100">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = DialogPrimitive.Content.displayName;

export const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-2 text-center sm:text-left", className)} {...props} />
);
SheetHeader.displayName = "SheetHeader";

export const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-2", className)} {...props} />
);
SheetFooter.displayName = "SheetFooter";

export const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-lg font-bold tracking-tight", className)} {...props} />
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;

export const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
SheetDescription.displayName = DialogPrimitive.Description.displayName;
