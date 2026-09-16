import * as React from "react";
import { cn } from "../../lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export /*
 * `h-[44px]`, not `h-10`: the root font-size is 14px at every width (index.css), so `h-10` renders
 * at 35px — under the 44px touch minimum — on desktop and phone alike. Inputs and selects are the
 * most-tapped controls on a phone form, so they were the most consequential of the app-wide finding
 * recorded in docs/V12_UiUx_ClickUp_PLAN.md. `select.tsx` and `button.tsx` carry the same fix.
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          "focus-ring flex h-[44px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          className
        )}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";
