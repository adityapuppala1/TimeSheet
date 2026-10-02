/**
 * The account-level gates in front of the whole console: things an operator has to put right about
 * their OWN account before the console admits them to anything else.
 *
 * Enforced in middleware/platform-admin-auth.ts#requirePlatformAdmin, which every authenticated
 * console route already passes through, so a route cannot be added without it. The `/auth/*` routes
 * stay open — they are the way out (change the password, see your sessions, sign out), and a gate
 * that also closed its own exit would be a lockout.
 */
export type PlatformAccountGateCode = "PASSWORD_ROTATION_REQUIRED";

export interface PlatformAccountGate {
  code: PlatformAccountGateCode;
  message: string;
}

export interface GateSubject {
  mustChangePassword: boolean;
}

/** The routes about the caller's own account, which no gate may close. */
export function isAccountEssentialPath(path: string): boolean {
  return path === "/auth" || path.startsWith("/auth/");
}

/** Which gate, if any, stands in front of this operator. */
export function platformAccountGateFor(admin: GateSubject): PlatformAccountGate | null {
  if (admin.mustChangePassword) {
    return {
      code: "PASSWORD_ROTATION_REQUIRED",
      message: "This account is still on a password somebody else issued. Choose your own before using the console."
    };
  }
  return null;
}
