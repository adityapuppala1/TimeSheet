/**
 * WHAT: the earliest date a timesheet entry may be given, for the date pickers to grey out against.
 *
 * WHERE THE NUMBER COMES FROM: the workspace admin's setting on Workspace Settings → Ticketing,
 * read through `/settings/effective-flags` — the one settings route every role may call. Employees
 * log time too, so they cannot be sent to the super-admin-only `/settings/ticketing`.
 *
 * WHAT UNDEFINED MEANS: "do not restrict the picker". It is returned while the setting is loading,
 * when the request failed, and when the workspace chose NO LIMIT. The server is the authority on
 * every one of those — it refuses an old date either way — so a picker that guessed (say, assumed
 * seven days while the answer was still in flight) would grey out days in a workspace that allows
 * them, which is a worse failure than showing a day the server then declines with a clear message.
 *
 * Shares its cache key with Tickets and Insights, so opening the timesheet form does not add a
 * request when the page has already asked.
 */
import { useQuery } from "@tanstack/react-query";
import { earliestLoggableDateFor } from "@timesheet/shared";
import { settingsApi } from "../services/api";

/** `YYYY-MM-DD` of the earliest allowed date given the author's today, or undefined for "no restriction". */
export function useEarliestLoggableDate(todayKey: string): string | undefined {
  const flags = useQuery({ queryKey: ["settings", "effective-flags"], queryFn: settingsApi.getEffectiveFlags, staleTime: 5 * 60_000 });
  if (!flags.data) return undefined;
  return earliestLoggableDateFor(todayKey, flags.data.timesheetBackdateDays) ?? undefined;
}
