/**
 * The one sentence every per-person chart uses to admit that somebody is missing from it.
 *
 * WHY IT EXISTS: deactivated people were removed from every per-person breakdown in the UI (see
 * `apps/api/src/services/people-visibility.service.ts` for the rule and its boundary). Removing
 * them silently trades one wrong number for another — a manager who knows seven people logged time
 * and counts five rows has no way to tell a deliberate exclusion from data loss, and the reasonable
 * conclusion is that the chart is broken. So the server returns how many it dropped, and this says
 * so, in the same words, under every chart that dropped any.
 *
 * WHY IT ALSO NAMES THE ESCAPE HATCH: the numbers are not gone, they moved. Anyone who needs a
 * period covered completely — a payroll reconciliation, a client invoice query, an audit — should
 * not have to ask whether the download still contains everybody.
 *
 * Renders nothing when nobody was hidden, so a card can include it unconditionally without growing
 * an empty line. The wording and that decision both live in `describeHiddenPeople`, where they can
 * be tested; everything left here is a paragraph.
 */
import { describeHiddenPeople } from "../utils/inactive-people";

export function InactivePeopleNote({ count, className = "" }: Readonly<{ count?: number; className?: string }>) {
  const note = describeHiddenPeople(count);
  if (!note) return null;
  return <p className={`px-4 pb-3 pt-1 text-xs text-muted-foreground ${className}`.trim()}>{note}</p>;
}
