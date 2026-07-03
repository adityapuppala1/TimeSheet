import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const alertVariants = cva(
  "relative w-full rounded-lg border px-4 py-3 text-sm [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg~*]:pl-7 [&>svg]:h-4 [&>svg]:w-4",
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

export const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
));
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
