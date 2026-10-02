/**
 * What GET /email-intake/settings reports about the loop guard: how many inbound messages it
 * dropped as automated (auto-replies, bounces, bulk mail), and the latest one's reason.
 *
 * Optional on the response so an SPA served against an older server degrades to saying nothing.
 */
export interface EmailIntakeAutomatedDrops {
  count: number;
  lastReason: string | null;
  lastFrom: string | null;
  lastAt: string | null;
}

/**
 * The one line the Mailbox connection card prints, or null when there is nothing to say.
 *
 * A drop used to leave only a server console line, so a guard that misfired — it once discarded
 * every customer message relayed through a Google Group — was invisible to whoever runs intake.
 */
export function automatedDropsNote(drops: EmailIntakeAutomatedDrops | undefined): string | null {
  if (!drops || drops.count <= 0) return null;
  const noun = drops.count === 1 ? "message" : "messages";
  let note = `${drops.count} automated ${noun} skipped (auto-replies, bounces and bulk mail never become tickets).`;
  if (drops.lastReason) {
    const from = drops.lastFrom ? `, from ${drops.lastFrom}` : "";
    note += ` Latest: ${drops.lastReason}${from}.`;
  }
  return note;
}
