/**
 * The account-level gates in front of the whole console: things an operator has to put right about
 * their OWN account before the console admits them to anything else.
 *
 * Enforced in middleware/platform-admin-auth.ts#requirePlatformAdmin, which every authenticated
 * console route already passes through, so a route cannot be added without it. The `/auth/*` routes
 * stay open — they are the way out (change the password, enrol a factor, see your sessions, sign
 * out), and a gate that also closed its own exit would be a lockout.
 */
import type { PlatformRole } from "@timesheet/shared";

export type PlatformAccountGateCode = "PASSWORD_ROTATION_REQUIRED" | "MFA_ENROLMENT_REQUIRED";

export interface PlatformAccountGate {
  code: PlatformAccountGateCode;
  message: string;
}

export interface GateSubject {
  mustChangePassword: boolean;
  role: PlatformRole;
  mfaEnabled: boolean;
}

/**
 * The roles PLATFORM_ADMIN_REQUIRE_MFA applies to: the two that can delete or restore a workspace,
 * change the platform's configuration and — for OWNER — countersign somebody else's irreversible
 * action. SUPPORT, BILLING and READ_ONLY are not gated by it.
 */
const MFA_REQUIRED_ROLES: ReadonlySet<PlatformRole> = new Set<PlatformRole>(["OWNER", "OPERATOR"]);

/** The routes about the caller's own account, which no gate may close. */
export function isAccountEssentialPath(path: string): boolean {
  return path === "/auth" || path.startsWith("/auth/");
}

export function mfaEnrolmentRequiredFor(admin: Pick<GateSubject, "role" | "mfaEnabled">, requireMfa: boolean): boolean {
  return requireMfa && MFA_REQUIRED_ROLES.has(admin.role) && !admin.mfaEnabled;
}

/**
 * Which gate, if any, stands in front of this operator.
 *
 * THE PASSWORD COMES FIRST. A second factor enrolled on top of a password somebody else issued
 * binds the factor to whoever saw that password; rotating first means the factor is enrolled by
 * the person the account now actually belongs to.
 */
export function platformAccountGateFor(admin: GateSubject, opts: { requireMfa: boolean }): PlatformAccountGate | null {
  if (admin.mustChangePassword) {
    return {
      code: "PASSWORD_ROTATION_REQUIRED",
      message: "This account is still on a password somebody else issued. Choose your own before using the console."
    };
  }
  if (mfaEnrolmentRequiredFor(admin, opts.requireMfa)) {
    return {
      code: "MFA_ENROLMENT_REQUIRED",
      message: `This deployment requires two-factor authentication for the ${admin.role} role. Set up an authenticator before using the console.`
    };
  }
  return null;
}
