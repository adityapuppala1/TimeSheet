import * as React from "react";
import { cn } from "../../lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "focus-ring flex min-h-[88px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60",
        className
      )}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";
