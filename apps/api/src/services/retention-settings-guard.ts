/**
 * Which retention-policy changes need a second owner (H2).
 *
 * Deleting one workspace by hand is two-person. But the POLICY decides deletions for the whole fleet,
 * and one OPERATOR could reach the same place alone through it: shorten the window to seven days,
 * move the reminders up against it, switch auto-delete on, clear the snapshot directory so no copy is
 * kept, then run the daily pass twice. Each of those moves is a loosening of a safeguard, and any of
 * them makes the change two-person. Everything that leaves the policy as safe or safer — a later
 * check-in, a longer window, auto-delete OFF, the programme paused — stays single-person; a rule that
 * also caught those would be one operators learn to route around.
 *
 * "REMINDER LEAD TIME" is how long before the deletion a reminder lands: `retentionDays - day`. Two of
 * them matter, and shortening either is a loosening — the FIRST warning (the earliest reminder, the
 * most notice a customer gets) and the FINAL notice (the last reminder, the last chance).
 *
 * Pure: compares the live policy with the patch, so it is easy to test and cannot drift from the route.
 */
export interface RetentionPolicyShape {
  retentionDays: number;
  reminderDays: number[];
  autoDeleteEnabled: boolean;
  snapshotDir: string | null;
}

const leads = (policy: Pick<RetentionPolicyShape, "retentionDays" | "reminderDays">) => {
  const days = policy.reminderDays.filter((d) => Number.isFinite(d));
  if (!days.length || !Number.isFinite(policy.retentionDays)) return null;
  return { first: policy.retentionDays - Math.min(...days), final: policy.retentionDays - Math.max(...days) };
};

/** What this change loosens, as sentences — empty when it is single-person. */
export function retentionSettingsRisks(current: Partial<RetentionPolicyShape>, patch: Partial<RetentionPolicyShape>): string[] {
  const risks: string[] = [];
  const next = { ...current, ...patch };

  if (typeof patch.retentionDays === "number" && typeof current.retentionDays === "number" && patch.retentionDays < current.retentionDays) {
    risks.push(`shortens the retention window from ${current.retentionDays} to ${patch.retentionDays} days`);
  }

  if (patch.reminderDays !== undefined || patch.retentionDays !== undefined) {
    const before = current.reminderDays && current.retentionDays !== undefined ? leads(current as RetentionPolicyShape) : null;
    const after = next.reminderDays && next.retentionDays !== undefined ? leads(next as RetentionPolicyShape) : null;
    if (before && after && (after.first < before.first || after.final < before.final)) {
      risks.push("gives customers less notice before their workspace is deleted");
    }
  }

  if (patch.autoDeleteEnabled === true && current.autoDeleteEnabled !== true) risks.push("switches automatic deletion on");

  if (patch.snapshotDir !== undefined && !patch.snapshotDir?.trim() && current.snapshotDir) {
    risks.push("stops taking a snapshot before each deletion");
  }

  return risks;
}
