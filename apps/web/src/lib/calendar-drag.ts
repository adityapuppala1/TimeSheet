/**
 * WHAT: what dropping a calendar chip on a day means for the item's dates.
 *
 * WHY PURE: the calendar's drag is a UI gesture, but "where does a three-day task land when its
 * first day is dropped on the 14th" is arithmetic — and arithmetic on dates is where calendars go
 * wrong (month ends, an end before a start). Kept here, tested here; the component only asks.
 *
 * SOURCE (V12 state file, 3.19): the reference lets you "drag and drop existing tasks on the
 * calendar to change their dates". Two cases:
 *  - a SCHEDULED item keeps its length: start moves to the drop day, end moves by the same delta;
 *  - an UNSCHEDULED item (only an SLA date) becomes scheduled ON that day — dropping it is the act
 *    of planning it, so start = end = the day. Its SLA date is not touched.
 */

const MS_PER_DAY = 86_400_000;

export interface SchedulableItem {
  isScheduled: boolean;
  startDate: string | null;
  endDate: string | null;
}

export interface SchedulePatch {
  startDate: string;
  endDate: string;
}

const toDay = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** `dropDay` is YYYY-MM-DD. Returns null when the drop changes nothing (same start day). */
export function shiftSchedule(item: SchedulableItem, dropDay: string): SchedulePatch | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dropDay)) return null;
  if (item.isScheduled && item.startDate && item.endDate) {
    const start = toDay(item.startDate);
    const end = toDay(item.endDate);
    const target = toDay(dropDay);
    const delta = Math.round((target.getTime() - start.getTime()) / MS_PER_DAY);
    if (delta === 0) return null;
    const length = Math.max(0, Math.round((end.getTime() - start.getTime()) / MS_PER_DAY));
    return { startDate: dayKey(target), endDate: dayKey(new Date(target.getTime() + length * MS_PER_DAY)) };
  }
  return { startDate: dropDay, endDate: dropDay };
}

/** The seven days of the Monday-start week containing `anchor` (YYYY-MM-DD). */
export function weekDays(anchor: string): string[] {
  const d = toDay(anchor);
  const dow = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d.getTime() - dow * MS_PER_DAY);
  return Array.from({ length: 7 }, (_, i) => dayKey(new Date(monday.getTime() + i * MS_PER_DAY)));
}

export function addDaysKey(day: string, n: number): string {
  return dayKey(new Date(toDay(day).getTime() + n * MS_PER_DAY));
}
