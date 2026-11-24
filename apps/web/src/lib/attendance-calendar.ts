/**
 * Month grid for the My attendance heat-map (V17 UI v2). Pure: dates are YYYY-MM-DD keys, weeks start
 * on Monday, and a cell outside the month is kept as padding so every row has seven columns.
 */
export interface MonthCell<T> {
  date: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  data: T | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11" for a key. */
export const monthOf = (dateKey: string) => dateKey.slice(0, 7);

export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${y}-${pad(m)}-${pad(last)}` };
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

export const addDayKeys = (key: string, days: number) =>
  new Date(new Date(`${key}T12:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

/** Monday = 0 … Sunday = 6. */
export function mondayIndex(dateKey: string): number {
  return (new Date(`${dateKey}T12:00:00Z`).getUTCDay() + 6) % 7;
}

export const WEEKDAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Rows of seven cells covering the month, padded with the neighbouring months' days. */
export function buildMonthGrid<T>(month: string, today: string, lookup: (dateKey: string) => T | null | undefined): Array<Array<MonthCell<T>>> {
  const { from, to } = monthBounds(month);
  const start = addDayKeys(from, -mondayIndex(from));
  const end = addDayKeys(to, 6 - mondayIndex(to));
  const rows: Array<Array<MonthCell<T>>> = [];
  let row: Array<MonthCell<T>> = [];
  for (let d = start; d <= end; d = addDayKeys(d, 1)) {
    const inMonth = d >= from && d <= to;
    row.push({ date: d, day: Number(d.slice(8)), inMonth, isToday: d === today, data: inMonth ? (lookup(d) ?? null) : null });
    if (row.length === 7) {
      rows.push(row);
      row = [];
    }
  }
  return rows;
}

/** Monday of the week containing `dateKey`. */
export const weekStart = (dateKey: string) => addDayKeys(dateKey, -mondayIndex(dateKey));

export const weekDays = (dateKey: string): string[] => Array.from({ length: 7 }, (_, i) => addDayKeys(weekStart(dateKey), i));
