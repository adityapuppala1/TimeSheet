import { Toaster as SonnerToaster, toast } from "sonner";

export function Toaster() {
  return (
    <SonnerToaster
      position="top-right"
      richColors
      closeButton
      expand
      duration={4500}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-popover group-[.toaster]:text-popover-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          error: "group-[.toaster]:!border-destructive/40",
          success: "group-[.toaster]:!border-success/40",
          warning: "group-[.toaster]:!border-warning/40",
          info: "group-[.toaster]:!border-info/40"
        }
      }}
    />
  );
}

export { toast };
