import * as React from "react";
import { cn } from "../../lib/utils";

/**
 * FRAMELESS MODE. A settings section (components/settings/settings-sections.tsx) already draws the
 * border, the icon and the title; a card component rendered inside it would otherwise draw a
 * second border and a second title one line below. With this context set to "frameless" the
 * nearest `Card` drops its frame, its `CardHeader` keeps only the description (the section's
 * header IS the title), and its `CardContent` loses the padding the section already provides.
 *
 * "embedded" is the same without hiding the title: several cards in one section (a group), each
 * keeping its own heading as a sub-heading, since the section's title names the group and not
 * any one of them.
 *
 * The mode applies to the NEAREST card only: `Card` resets it to "framed" for its descendants, so
 * a card nested inside that card's body (a provider row, a run detail) keeps its own frame. A card
 * mounted anywhere else in the app is byte-for-byte what it was.
 */
export type CardFrame = "framed" | "frameless" | "embedded";
export const CardFrameContext = React.createContext<CardFrame>("framed");
const CardHeaderContext = React.createContext<CardFrame>("framed");

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const frame = React.useContext(CardFrameContext);
    const node = (
      <div
        ref={ref}
        // min-w-0/max-w-full: grid and flex ITEMS default to `min-width: auto`, which means a
        // card holding intrinsically-wide content (a min-width scroller, a histogram) silently
        // stretches every ancestor grid wider than the phone viewport instead of letting its own
        // overflow-x-auto container scroll. Cards must always be shrinkable — this is what keeps
        // "wide content scrolls inside its own container, the page never scrolls sideways"
        // (CONTRIBUTING.md) true by construction rather than per-page vigilance.
        className={cn(
          "min-w-0 max-w-full",
          frame === "framed" ? "rounded-lg border border-border bg-card text-card-foreground shadow-soft" : "grid gap-4",
          className
        )}
        data-card-frame={frame}
        {...props}
      />
    );
    // Descendants always see "framed" (a nested card keeps its frame); this card's own header and
    // content read the mode this card was given.
    return (
      <CardFrameContext.Provider value="framed">
        <CardHeaderContext.Provider value={frame}>{node}</CardHeaderContext.Provider>
      </CardFrameContext.Provider>
    );
  }
);
Card.displayName = "Card";

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const frame = React.useContext(CardHeaderContext);
    return <div ref={ref} className={cn("flex flex-col space-y-1.5", frame === "framed" ? "p-5" : "empty:hidden", className)} data-card-header={frame} {...props} />;
  }
);
CardHeader.displayName = "CardHeader";

export const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => {
    // Inside a frameless card's header the section shell has already said the title; in an
    // embedded one it is a sub-heading of the section.
    const frame = React.useContext(CardHeaderContext);
    if (frame === "frameless") return null;
    if (frame === "embedded") return <h4 ref={ref} className={cn("text-sm font-semibold leading-none", className)} {...props} />;
    return <h3 ref={ref} className={cn("text-lg font-bold leading-none tracking-tight", className)} {...props} />;
  }
);
CardTitle.displayName = "CardTitle";

export const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
  )
);
CardDescription.displayName = "CardDescription";

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const frame = React.useContext(CardHeaderContext);
    return <div ref={ref} className={cn(frame === "framed" ? "p-5 pt-0" : "p-0", className)} {...props} />;
  }
);
CardContent.displayName = "CardContent";

export const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center p-5 pt-0", className)} {...props} />
  )
);
CardFooter.displayName = "CardFooter";
