import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "../../lib/utils";

export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      // overflow-x-auto (new) so a TabsList wider than its container scrolls horizontally
      // instead of being silently clipped by html/body's `overflow-x: clip` (index.css) —
      // without this, tabs past the visible width are unreachable on narrow viewports, not
      // just visually cramped. Fixes every TabsList consumer at once (ticket detail sheet,
      // WorkspaceSettings, etc.). Stays inline-flex (not flex) so a short TabsList still
      // shrink-wraps to its content
      // instead of stretching to fill its container — inline-flex's shrink-to-fit sizing
      // already caps at the container's available width, which combined with overflow-x-auto
      // is what makes internal scrolling kick in instead of growing past the container.
      // justify-start, not justify-center: flexbox "unsafe" centering clips the start of
      // overflowing content in a scroll container (a well-known CSS footgun) — start-aligned
      // avoids that while looking identical for any TabsList that fits without overflowing.
      "inline-flex h-10 max-w-full items-center justify-start gap-1 overflow-x-auto whitespace-nowrap rounded-md bg-muted p-1 text-muted-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      className
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "focus-ring inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn("focus-ring mt-3", className)} {...props} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;
