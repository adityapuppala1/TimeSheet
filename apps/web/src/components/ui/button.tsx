import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

export const buttonVariants = cva(
  "focus-ring pressable inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold motion-safe:transition disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:brightness-110 active:brightness-95",
        destructive: "bg-destructive text-destructive-foreground shadow-xs hover:brightness-110 active:brightness-95",
        success: "bg-success text-success-foreground shadow-xs hover:brightness-110 active:brightness-95",
        outline: "border border-input bg-background hover:bg-muted hover:text-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-muted hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        /* Marks a control that SPENDS A MODEL CALL when pressed. Distinct from `.ai-glow`, which
           means the model is working on that box right now — see the AI effect layer in index.css. */
        ai: "ai-specular shadow-xs"
      },
      /*
       * Heights in ABSOLUTE PIXELS, not rem utilities — and this is the one place in the app where
       * that decision buys the most.
       *
       * index.css sets the root font-size to 14px at every width, so every rem-based Tailwind size
       * lands at 14/16 of its nominal value: `h-10` is 35px, `h-11` is 38.5px, `h-12` is 42px.
       * Every button in the product was therefore under the 44px touch minimum the V12 plan holds
       * to (WCAG 2.5.5 / Apple HIG / Material), and passed nobody's eye because the numbers LOOK
       * right in the class names. Found by measuring the Profile accent swatches at 390px, then
       * confirmed at 768 and 1366 — not by reading this file, where nothing looks wrong.
       *
       * `default`, `lg` and `icon` now clear 44px; `xl` keeps its step above `lg`. `sm` is left
       * exactly as it was — it is the deliberate compact size for dense toolbars and table rows,
       * and the touch rule is about primary actions, not every affordance. Callers that stack
       * `size="sm"` in a phone layout are the shell unit's follow-up, not this variant's problem.
       */
      size: {
        default: "h-[44px] px-4 py-2 text-sm",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-[44px] rounded-md px-6 text-sm",
        xl: "h-[48px] rounded-md px-7 text-base",
        icon: "h-[44px] w-[44px]"
      }
    },
    defaultVariants: { variant: "default", size: "default" }
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
  }
);
Button.displayName = "Button";
