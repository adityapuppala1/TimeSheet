/**
 * WHAT: the one decision about how the punch-in experience shows itself, as a pure function, plus
 * the small shared store the OTHER first-load surfaces read to wait their turn.
 *
 * THE ORDER IN THE SHELL (layouts/AppLayout.tsx), top to bottom of precedence:
 *   1. ForcedPasswordChange / ForcedMfaSetup — early returns; the shell is not even mounted.
 *   2. OnboardingGate — a new account finishes setup first. Punch-in says nothing while it is up:
 *      someone who cannot use the app yet has nothing to punch in to.
 *   3. Punch-in (this) — dialog/sheet, mandatory overlay, banner or a small notice.
 *   4. FaceModelUpgradePrompt and the product tour — both wait while punch-in `holdsOthers`, so a
 *      new joiner is never shown three modals stacked on their first morning.
 *   SessionEndedDialog stays above everything; a force-logout must always reach the tab.
 *
 * WHY A PURE FUNCTION: the order is the part most likely to regress when the next first-load
 * surface is added, and a function of plain inputs is testable without rendering the shell
 * (tests/unit/punch-in-gate.test.ts).
 */
import { create } from "zustand";
import type { MyToday } from "../services/attendance-api";

export type PunchInSurface = "none" | "notice" | "dialog" | "banner" | "gate";

/** What the person already dismissed today: nothing, the dialog (→ banner), or the banner too. */
export type PunchInDismissal = "none" | "dialog" | "banner";

export interface PunchInDecisionInput {
  /** undefined while the status query is still loading; null when it failed. */
  today: MyToday | null | undefined;
  onboardingBlocked: boolean;
  /** True while the onboarding status itself is still unknown. */
  onboardingLoading: boolean;
  pathname: string;
  dismissal: PunchInDismissal;
  /** The viewer's role. Admins are never shown the blocking gate (see decidePunchIn). */
  role?: string;
}

export interface PunchInDecision {
  surface: PunchInSurface;
  /** True when FaceModelUpgradePrompt and the auto-started tour must wait. */
  holdsOthers: boolean;
}

/** Mandatory mode leaves exactly these reachable — the profile (where face enrolment lives). */
export const PUNCH_IN_ESCAPE_HATCH = "/app/profile";
/** Where an administrator turns attendance off. */
export const WORKSPACE_SETTINGS_PATH = "/app/settings";

const ADMIN_ROLES = new Set(["SUPER_ADMIN", "ADMIN"]);

export function isGateExempt(role: string | undefined): boolean {
  return role !== undefined && ADMIN_ROLES.has(role);
}

/** The routes the mandatory overlay steps aside for. Admins also keep workspace settings — defence
 *  in depth: they never get the gate, but if they ever did they must still reach the off switch. */
export function gateEscapeHatches(role: string | undefined): string[] {
  return isGateExempt(role) ? [PUNCH_IN_ESCAPE_HATCH, WORKSPACE_SETTINGS_PATH] : [PUNCH_IN_ESCAPE_HATCH];
}

const NONE: PunchInDecision = { surface: "none", holdsOthers: false };

export function decidePunchIn(input: PunchInDecisionInput): PunchInDecision {
  // Onboarding outranks punch-in; it already holds the face prompt on its own.
  if (input.onboardingBlocked) return NONE;
  // Unknown yet: hold the tour/face prompt rather than let them open and be covered a moment later.
  if (input.today === undefined || input.onboardingLoading) return { surface: "none", holdsOthers: true };
  const today = input.today;
  // A failed status read must never lock anyone out — attendance is not worth a broken app.
  if (!today?.enabled || today.punchInMode === "OFF" || today.punchInMode === undefined) return NONE;
  if (today.record) return { surface: "notice", holdsOthers: false };
  if (!today.isWorkingDay) return NONE;

  // An administrator is never blocked: if location REQUIRED is denied or a face BLOCK fails on their
  // device, the gate would lock out the one person who can turn it off. They get OPTIONAL's
  // dialog → banner instead; the rule itself is unchanged for everyone else.
  if (today.punchInMode === "MANDATORY" && !isGateExempt(input.role)) {
    // On the profile the overlay steps aside (they may need to enrol a face), but still holds others.
    if (gateEscapeHatches(input.role).some((p) => input.pathname.startsWith(p))) return { surface: "none", holdsOthers: true };
    return { surface: "gate", holdsOthers: true };
  }
  // OPTIONAL (and MANDATORY for an administrator)
  if (input.dismissal === "none") return { surface: "dialog", holdsOthers: true };
  if (input.dismissal === "dialog") return { surface: "banner", holdsOthers: false };
  return NONE;
}

/* ------------------------------------------------------------------ *
 * Dismissal memory — per user and LOCAL calendar day, so a shared machine does not carry one
 * person's "later" to the next, and tomorrow asks again. Storage can throw (private mode, blocked
 * site data); the fallback is simply "not dismissed", which only means being asked again.
 * ------------------------------------------------------------------ */

export function dismissalKey(userId: string, localDate: string): string {
  return `attendance.punch-dismissed.${userId}.${localDate}`;
}

export function readDismissal(userId: string, localDate: string): PunchInDismissal {
  try {
    const value = window.localStorage.getItem(dismissalKey(userId, localDate));
    return value === "dialog" || value === "banner" ? value : "none";
  } catch {
    return "none";
  }
}

export function writeDismissal(userId: string, localDate: string, value: PunchInDismissal): void {
  try {
    window.localStorage.setItem(dismissalKey(userId, localDate), value);
  } catch {
    /* storage unavailable — the person is asked again next load, which is harmless */
  }
}

/* ------------------------------------------------------------------ *
 * Shared state: PunchInController writes, Topbar (tour), AppLayout (face prompt) and the banner read.
 * ------------------------------------------------------------------ */

interface PunchInGateState {
  holdsOthers: boolean;
  dismissal: PunchInDismissal;
  /** Set by the banner's "Punch in" button to reopen the dialog. */
  reopenRequested: boolean;
  setHoldsOthers: (value: boolean) => void;
  setDismissal: (value: PunchInDismissal) => void;
  requestReopen: (value: boolean) => void;
}

export const usePunchInGate = create<PunchInGateState>((set) => ({
  // Starts held: until the first decision runs, the tour/face prompt should not race ahead.
  holdsOthers: true,
  dismissal: "none",
  reopenRequested: false,
  setHoldsOthers: (holdsOthers) => set({ holdsOthers }),
  setDismissal: (dismissal) => set({ dismissal }),
  requestReopen: (reopenRequested) => set({ reopenRequested })
}));

/** "08:50" in the viewer's locale — for the "Punched in 08:50 via Biometric" notice. */
export function punchNotice(record: { punchInAt: string; sourceLabel: string }): string {
  const time = new Date(record.punchInAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Punched in ${time} via ${record.sourceLabel}`;
}
