/**
 * WHAT: who a rich-text body mentions — the ids the editor wrote into `data-mention-id`.
 *
 * WHY IDS AND NOT NAMES: "@Ana" is ambiguous the day a second Ana joins, and a name typed by
 * hand is not a mention, it is text. The editor's @-popup only offers the people the writer can
 * already see (the project's members), and it writes the chosen person's id; this reads those
 * ids back after sanitising, so what notifies is exactly what was chosen. The caller still checks
 * each id against the project's membership — an id pasted into the HTML by hand notifies nobody
 * who could not see the ticket anyway.
 *
 * SOURCE (V12 state file, 8.1): "Use @mentions" — mentioned people are notified and do not become
 * followers unless they choose to.
 */

const MENTION_ID = /data-mention-id="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;

/** Unique ids in document order; malformed ids are ignored rather than trusted. */
export function extractMentionIds(html: string | null | undefined): string[] {
  if (!html) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of html.matchAll(MENTION_ID)) {
    const id = m[1].toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
