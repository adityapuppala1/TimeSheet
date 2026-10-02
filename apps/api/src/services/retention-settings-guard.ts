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

/** Does the change move the first warning or the final notice closer to the deletion? */
function shortensNotice(current: Partial<RetentionPolicyShape>, next: Partial<RetentionPolicyShape>): boolean {
  const before = current.reminderDays && current.retentionDays !== undefined ? leads(current as RetentionPolicyShape) : null;
  const after = next.reminderDays && next.retentionDays !== undefined ? leads(next as RetentionPolicyShape) : null;
  return Boolean(before && after && (after.first < before.first || after.final < before.final));
}

/** Every field the console's policy form edits. */
export interface RetentionPolicyFields extends RetentionPolicyShape {
  enabled: boolean;
  feedbackDay: number;
}

export type RetentionSettingsChanges = { [K in keyof RetentionPolicyFields]?: { from: RetentionPolicyFields[K]; to: RetentionPolicyFields[K] } };

const RETENTION_FIELDS = ["enabled", "feedbackDay", "reminderDays", "retentionDays", "autoDeleteEnabled", "snapshotDir"] as const;

/** The form's view of a value: reminder days as the set they are stored as, a blank directory as none. */
function comparable(field: keyof RetentionPolicyFields, value: unknown): string {
  if (field === "reminderDays" && Array.isArray(value)) return JSON.stringify([...new Set(value as number[])].sort((a, b) => a - b));
  if (field === "snapshotDir") return JSON.stringify((typeof value === "string" ? value.trim() : "") || null);
  return JSON.stringify(value);
}

/**
 * The fields a save actually changes, old and new (R1-3). The console's form sends the whole policy
 * every time, so a queued loosening has to be cut down to its difference: that is what the approver
 * reads, and the only thing an approval may apply — replaying the whole form would put back every
 * field somebody else changed while the request waited.
 */
export function retentionSettingsChanges(current: RetentionPolicyFields, patch: Partial<RetentionPolicyFields>): RetentionSettingsChanges {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of RETENTION_FIELDS) {
    if (patch[field] === undefined || comparable(field, patch[field]) === comparable(field, current[field])) continue;
    changes[field] = { from: current[field], to: patch[field] };
  }
  return changes as RetentionSettingsChanges;
}

/** What this change loosens, as sentences — empty when it is single-person. */
export function retentionSettingsRisks(current: Partial<RetentionPolicyShape>, patch: Partial<RetentionPolicyShape>): string[] {
  const risks: string[] = [];

  if (typeof patch.retentionDays === "number" && typeof current.retentionDays === "number" && patch.retentionDays < current.retentionDays) {
    risks.push(`shortens the retention window from ${current.retentionDays} to ${patch.retentionDays} days`);
  }

  if ((patch.reminderDays !== undefined || patch.retentionDays !== undefined) && shortensNotice(current, { ...current, ...patch })) {
    risks.push("gives customers less notice before their workspace is deleted");
  }

  if (patch.autoDeleteEnabled === true && current.autoDeleteEnabled !== true) risks.push("switches automatic deletion on");

  if (patch.snapshotDir !== undefined && !patch.snapshotDir?.trim() && current.snapshotDir) {
    risks.push("stops taking a snapshot before each deletion");
  }

  return risks;
}
