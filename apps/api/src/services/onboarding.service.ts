/**
 * WHAT: decides whether a person still has first-run setup to finish, and records when they're done.
 *
 * WHY IT'S SERVER-SIDE: the gate blocks the app, so the client must not be the thing that decides
 * whether it's satisfied. A browser-side check can be skipped by anyone who opens devtools, and
 * the requirements (is face verification on for this workspace? does the policy cover this person?)
 * are workspace state the client only has a cached copy of.
 *
 * WHY `onboardingCompletedAt` IS STORED RATHER THAN DERIVED: deriving "are they set up?" purely
 * from whether the profile fields are filled means every existing user gets locked out the moment
 * an admin adds a requirement — punishing people for a configuration change they had no part in.
 * That was the stated reason the dashboard checklist was originally built NOT to block. The stored
 * timestamp, plus a migration that backfills every existing user as already-onboarded, keeps that
 * objection answered: the gate only ever applies to accounts created after it shipped.
 */
import { prisma } from "../config/prisma.js";
import { getFaceSettings } from "./face.service.js";

export interface OnboardingStatus {
  /** True when the app should be blocked for this user right now. */
  blocked: boolean;
  /** Already finished at some point — the gate never returns for them. */
  completedAt: Date | null;
  profile: { complete: boolean; missing: string[] };
  face: { required: boolean; enrolled: boolean };
}

/** The profile fields first-run setup asks for. Deliberately short: this gate blocks the whole
 *  app, so every field it demands has to be one a new joiner can actually answer on day one. An
 *  avatar is NOT included — it's encouraged by the dashboard checklist, not required to work. */
function missingProfileFields(user: { phoneNumber: string | null; timezone: string | null }): string[] {
  const missing: string[] = [];
  if (!user.phoneNumber?.trim()) missing.push("phoneNumber");
  if (!user.timezone?.trim()) missing.push("timezone");
  return missing;
}

export async function getOnboardingStatus(userId: string): Promise<OnboardingStatus> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, phoneNumber: true, timezone: true, onboardingCompletedAt: true }
  });

  const missing = missingProfileFields(user);
  const profileComplete = missing.length === 0;

  // Face enrollment is only ever part of this when the workspace has the feature on AND the policy
  // actually covers this person. An org with face verification off must never see this gate
  // mention it, let alone be held by it.
  const settings = await getFaceSettings();
  const faceRequired =
    settings.enabled && (settings.requireForTimesheet || settings.requireForTicket || settings.requireForApproval);

  const enrollment = faceRequired
    ? await prisma.faceEnrollment.findUnique({ where: { userId }, select: { id: true } })
    : null;
  const faceEnrolled = !faceRequired || Boolean(enrollment);

  // Already finished: nothing re-opens the gate. If an admin later turns face verification on, the
  // dashboard checklist nags and submissions 428 — both recoverable — rather than locking someone
  // out of an app they were using five minutes ago.
  if (user.onboardingCompletedAt) {
    return {
      blocked: false,
      completedAt: user.onboardingCompletedAt,
      profile: { complete: profileComplete, missing },
      face: { required: faceRequired, enrolled: faceEnrolled }
    };
  }

  // Self-closing: the moment the requirements are met the timestamp is written, so the gate
  // disappears without needing the client to call a separate "I'm done" endpoint it might skip.
  if (profileComplete && faceEnrolled) {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { onboardingCompletedAt: new Date() },
      select: { onboardingCompletedAt: true }
    });
    return {
      blocked: false,
      completedAt: updated.onboardingCompletedAt,
      profile: { complete: true, missing: [] },
      face: { required: faceRequired, enrolled: faceEnrolled }
    };
  }

  return {
    blocked: true,
    completedAt: null,
    profile: { complete: profileComplete, missing },
    face: { required: faceRequired, enrolled: faceEnrolled }
  };
}
