/**
 * WHAT: the one place the workspace's analytics surfaces turn a number, an amount of money, a count
 * of hours or a date into text.
 *
 * WHY IT EXISTS: every chart and tile used to call `toLocaleString()` with no locale, or
 * `toFixed(n)` with whatever `n` its author picked, or hardcode a "$". So one browser printed
 * 1,00,000 next to another page's $100,000, hours showed with one decimal here and two there, and an
 * INR amount wore a dollar sign. The reader cannot tell which of those differences mean something.
 *
 * THE DECISIONS, each made once here:
 *   - Locale `en-IN` unless a caller passes another. There is no workspace locale setting yet; when
 *     one exists, it is passed through `setFormatLocale` at sign-in and nothing else changes.
 *   - Money always carries the currency it came with. There is no default currency here on purpose:
 *     a symbol picked by the formatter is how "$" ended up on rupees. No currency, no symbol.
 *   - Hours have exactly one decimal, so a column of them lines up and 7.5 never reads as 7.50 in one
 *     row and 7.5 in the next.
 *   - Dates read "2 Oct 2026" — never MM-DD, which half the world reads backwards.
 *   - No data is not zero. Every function prints "—" for null, undefined or NaN, so a failed or
 *     empty figure can never be mistaken for a measured 0.
 */

export const DEFAULT_LOCALE = "en-IN";
/** What every formatter prints for a value that does not exist. */
export const NO_VALUE = "—";

let activeLocale = DEFAULT_LOCALE;

/** Switches the locale for every formatter. Falls back to en-IN for an empty or unusable tag. */
export function setFormatLocale(locale?: string | null): void {
  const candidate = locale?.trim();
  if (!candidate) {
    activeLocale = DEFAULT_LOCALE;
    return;
  }
  try {
    new Intl.NumberFormat(candidate);
    activeLocale = candidate;
  } catch {
    activeLocale = DEFAULT_LOCALE;
  }
}

export function formatLocale(): string {
  return activeLocale;
}

function isMissing(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined || Number.isNaN(value);
}

/** A plain number with grouping (12,34,567). Up to `maxDecimals` fraction digits. */
export function formatNumber(value: number | null | undefined, maxDecimals = 0): string {
  if (isMissing(value)) return NO_VALUE;
  return new Intl.NumberFormat(activeLocale, { maximumFractionDigits: maxDecimals }).format(value);
}

/** Hours with exactly one decimal and an "h": `7.5h`, `1,234.0h`. */
export function formatHours(value: number | null | undefined): string {
  if (isMissing(value)) return NO_VALUE;
  return `${new Intl.NumberFormat(activeLocale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)}h`;
}

/** A whole-number percentage: `45%`. Null when there was nothing to divide by — rendered "—". */
export function formatPercent(value: number | null | undefined, maxDecimals = 0): string {
  if (isMissing(value)) return NO_VALUE;
  return `${new Intl.NumberFormat(activeLocale, { maximumFractionDigits: maxDecimals }).format(value)}%`;
}

/** 12L / 1.2Cr / 1.2K in en-IN — for axis ticks and tight tiles where the full figure does not fit. */
export function formatCompact(value: number | null | undefined): string {
  if (isMissing(value)) return NO_VALUE;
  return new Intl.NumberFormat(activeLocale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/**
 * An amount in ITS OWN currency: `₹12,34,567.50`, `$1,200.00`.
 *
 * `currency` comes from the data — the project's billing currency, the row's frozen
 * `billedCurrency`. Without one the amount is printed bare rather than given a symbol it may not
 * have; an unknown ISO code is printed after the amount rather than thrown on.
 */
export function formatMoney(
  amount: number | null | undefined,
  currency: string | null | undefined,
  options: { compact?: boolean } = {}
): string {
  if (isMissing(amount)) return NO_VALUE;
  const code = currency?.trim().toUpperCase();
  if (!code) return formatNumber(amount, 2);
  try {
    return new Intl.NumberFormat(activeLocale, {
      style: "currency",
      currency: code,
      ...(options.compact ? { notation: "compact", maximumFractionDigits: 1 } : {})
    }).format(amount);
  } catch {
    return `${formatNumber(amount, 2)} ${code}`;
  }
}

/**
 * Parses what the API sends for a date: a `YYYY-MM-DD` day key (read as that CALENDAR day, never as
 * UTC midnight, which is the previous day west of Greenwich), an ISO timestamp, or a Date.
 */
function toDate(value: Date | string): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** "2 Oct 2026". */
export function formatDate(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return NO_VALUE;
  const date = toDate(value);
  if (!date) return NO_VALUE;
  return new Intl.DateTimeFormat(activeLocale, { day: "numeric", month: "short", year: "numeric" }).format(date);
}

/** "2 Oct" — for chart axes, where the year is the same on every tick. */
export function formatDayMonth(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return NO_VALUE;
  const date = toDate(value);
  if (!date) return NO_VALUE;
  return new Intl.DateTimeFormat(activeLocale, { day: "numeric", month: "short" }).format(date);
}
