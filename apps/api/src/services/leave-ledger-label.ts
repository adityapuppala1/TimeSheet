/**
 * What a ledger row is called on screen. The kind alone is not enough: a comp-off credit is posted
 * as ADJUSTMENT (so it counts in the balance's "adjusted" column) and its expiry as EXPIRY, which made
 * them read as a manager's hand edit. The idempotency key says what actually posted the row.
 */
export function leaveLedgerLabel(kind: string, idempotencyKey: string | null | undefined): string {
  if (idempotencyKey?.startsWith("COMPOFF-EXPIRY:")) return "Comp-off expired";
  if (idempotencyKey?.startsWith("COMPOFF:")) return "Comp-off credit";
  switch (kind) {
    case "ACCRUAL":
      return "Accrued";
    case "CARRY_FORWARD":
      return "Carried forward";
    case "DEBIT":
      return "Leave taken";
    case "CREDIT_REVERSAL":
      return "Leave restored";
    case "EXPIRY":
      return "Expired";
    case "ADJUSTMENT":
      return "Adjustment";
    default:
      return kind;
  }
}
