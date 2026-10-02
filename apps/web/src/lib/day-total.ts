/**
 * Hours the CURRENT user already has on one day, for the log form's daily-cap meter.
 *
 * WHY THE USER FILTER: the meter used to sum every row the list route returned for the date, and
 * that route returns the whole workspace to a `reports:view` holder — so a manager saw their
 * reports' hours piled onto their own and had Submit disabled by somebody else's day.
 *
 * REJECTED hours are left out: a refused entry no longer holds its time slot (the server's overlap
 * check ignores it too), and the hours are expected to be re-logged rather than counted twice.
 *
 * THE 12-HOUR CAP THIS FEEDS IS A CLIENT HINT, not a server rule: nothing on the API enforces a
 * per-day total (only 12h per ENTRY), the help manual calls it a "daily-cap warning", and drafts,
 * draft→submit and the MCP/Ask-AI logging tools are not held to it.
 */
export interface DayTotalRow {
  userId?: string | null;
  user?: { id?: string | null } | null;
  workDate: string;
  totalHours: number | string | null | undefined;
  status: string;
}

export function dayTotalFor(rows: readonly DayTotalRow[], userId: string | null | undefined, workDate: string): number {
  if (!userId) return 0;
  return rows
    .filter((row) => (row.userId ?? row.user?.id) === userId)
    .filter((row) => String(row.workDate).slice(0, 10) === workDate && row.status !== "REJECTED")
    .reduce((sum, row) => sum + Number(row.totalHours ?? 0), 0);
}
