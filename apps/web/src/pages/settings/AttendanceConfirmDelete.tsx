/**
 * WHAT: one icon-button-plus-confirm for every destructive row action in the Attendance settings
 * (calendar, holiday, reason, source).
 *
 * WHY: `window.confirm` is a blocking native box that ignores the theme, cannot be styled for
 * dark mode, and is suppressed in embedded/automated browsers — so a delete silently did nothing
 * there. The app already has AlertDialog for this; the four call sites share one wrapper so the
 * wording and the destructive colour stay identical.
 */
import type { ReactNode } from "react";
import { Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";

export function AttendanceConfirmDelete({
  label,
  title,
  description,
  disabled,
  onConfirm,
  className,
  iconClassName = "h-3.5 w-3.5"
}: Readonly<{
  /** Accessible name of the trigger, e.g. "Delete India 2027". */
  label: string;
  title: string;
  description: ReactNode;
  disabled?: boolean;
  onConfirm: () => void;
  className?: string;
  iconClassName?: string;
}>) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" className={className} aria-label={label} disabled={disabled}>
          <Trash2 className={iconClassName} />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
