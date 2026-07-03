import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { cn } from "../../lib/utils";
import { buttonVariants } from "./button";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

export function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col sm:flex-row gap-3",
        month: "flex flex-col gap-3",
        caption: "flex justify-center pt-1 relative items-center",
        caption_label: "text-sm font-bold",
        nav: "flex items-center gap-1",
        nav_button: cn(buttonVariants({ variant: "outline", size: "icon" }), "h-7 w-7 bg-transparent p-0 opacity-70 hover:opacity-100"),
        nav_button_previous: "absolute left-1",
        nav_button_next: "absolute right-1",
        table: "w-full border-collapse space-y-1",
        head_row: "flex",
        head_cell: "text-muted-foreground rounded-md w-9 font-semibold text-[0.7rem] uppercase",
        row: "flex w-full mt-2",
        cell: "h-9 w-9 text-center text-sm p-0 relative [&:has([aria-selected])]:bg-muted/50 focus-within:relative focus-within:z-20",
        day: cn(buttonVariants({ variant: "ghost" }), "h-9 w-9 p-0 font-normal aria-selected:opacity-100"),
        day_range_end: "day-range-end",
        day_selected: "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground",
        day_today: "bg-accent/30 text-accent-foreground font-semibold",
        day_outside: "text-muted-foreground opacity-50",
        day_disabled: "text-muted-foreground opacity-30",
        day_hidden: "invisible",
        ...classNames
      }}
      components={{
        Chevron: (chevronProps) => {
          if (chevronProps.orientation === "left") return <ChevronLeft className="h-4 w-4" />;
          return <ChevronRight className="h-4 w-4" />;
        }
      }}
      {...props}
    />
  );
}
