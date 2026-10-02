/**
 * WHAT: whether the signed-in person can work a change's runbook — tick steps, record a failure,
 * add a test result.
 *
 * WHY NOT `change.canEdit`: that is the PLAN's edit right, and it freezes for the requester and the
 * implementer once the change is approved. The runbook is the opposite — it is worked during
 * implementation, after approval — so it follows the API's own rule (`loadChangeForRunbook`): the
 * requester, the implementer (`isParty`), or a change manager (`canEdit` stays true for them). Only a
 * CLOSED change is read-only: its record is final.
 */
export function canWorkRunbook(change: { state: string; canEdit: boolean }, isParty: boolean): boolean {
  if (change.state === "CLOSED") return false;
  return change.canEdit || isParty;
}
