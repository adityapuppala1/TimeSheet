/**
 * 7.0.0 — opt into or out of one optional holiday on the Holidays screen. An optional holiday counts
 * as a day off only for people who opted in. The calendar's yearly cap is enforced by the server
 * (409 OPTIONAL_HOLIDAY_LIMIT); the button is disabled before that with the reason shown.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { optionalChoice } from "../../lib/holiday-opt-in";
import { runInBackground } from "../../lib/run-in-background";
import { attendanceApi } from "../../services/attendance-api";
import { Button } from "../ui/button";
import { toast } from "../ui/toaster";

const serverMessage = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

export function OptionalHolidayControl({
  holiday,
  cap,
  takenThisYear,
  today
}: Readonly<{ holiday: { id: string; date: string; name: string; isOptional: boolean; optedIn?: boolean }; cap: number | null; takenThisYear: number; today: string }>) {
  const queryClient = useQueryClient();
  const choice = optionalChoice(holiday, cap, takenThisYear, today);
  const toggle = useMutation({
    mutationFn: (action: "in" | "out") => (action === "in" ? attendanceApi.optInHoliday(holiday.id) : attendanceApi.optOutHoliday(holiday.id)),
    onSuccess: (_r, action) => {
      toast.success(action === "in" ? `${holiday.name} is a day off for you` : `${holiday.name} is a working day for you again`);
      runInBackground(queryClient.invalidateQueries({ queryKey: ["attendance", "me"] }));
    },
    onError: (err) => toast.error("Could not change it", { description: serverMessage(err, "Try again.") })
  });
  if (!choice) return null;
  const reasonId = `opt-reason-${holiday.id}`;
  return (
    <span className="flex flex-col items-end gap-0.5">
      <Button
        variant={choice.action === "in" ? "outline" : "secondary"}
        size="sm"
        className="min-h-[44px] sm:min-h-8"
        disabled={choice.disabled || toggle.isPending}
        aria-describedby={choice.reason ? reasonId : undefined}
        aria-label={`${choice.action === "in" ? "Take" : "Drop"} ${holiday.name}`}
        onClick={() => toggle.mutate(choice.action)}
      >
        {choice.action === "in" ? "Take this day" : "Taken · Drop"}
      </Button>
      {choice.reason && (
        <span id={reasonId} className="max-w-[12rem] text-right text-[11px] text-muted-foreground">
          {choice.reason}
        </span>
      )}
    </span>
  );
}
