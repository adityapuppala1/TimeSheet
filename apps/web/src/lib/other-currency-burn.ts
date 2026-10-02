import { formatMoney } from "./format";

/**
 * A project's burn billed in currencies other than its budget's, for printing BESIDE the burn —
 * "₹50,000 + €120". The API keeps it out of burn, burn %, the forecast and the risk flags (there is
 * no exchange rate to add it with), so the page must not add it either; each amount stays in its own
 * currency. Null when there is none, or when an older server does not send the field.
 */
export function otherCurrencyBurnText(other: Array<{ currency: string; amount: number }> | undefined): string | null {
  if (!other || other.length === 0) return null;
  return other.map((c) => formatMoney(c.amount, c.currency, { whole: true })).join(" + ");
}
