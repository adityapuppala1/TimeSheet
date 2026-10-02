/**
 * WHAT: the one password policy, applied wherever a person chooses a password for themselves —
 * self-service change (auth.service.ts#changePassword) and the emailed reset or welcome link
 * (#resetPassword). Security audit #10.
 *
 * WHAT IT CHECKS, and why each line is here:
 *  - At least 8 characters. ASVS 5.0 6.2.1's Level 1 floor, and the minimum this app has always
 *    had — raising it would refuse passwords people use today. (A higher floor belongs with MFA:
 *    NIST 800-63B-4 asks for 15 only when the password is the sole factor.)
 *  - At most 72 BYTES of UTF-8. bcrypt reads no further, and bcryptjs truncates silently: two
 *    different 81-character passwords that share their first 72 bytes hash identically. Refusing is
 *    honest; accepting would let somebody believe the tail of their passphrase protects them.
 *  - Not among the ~3000 most common passwords (ASVS 6.2.4) — the list in common-passwords.ts.
 *  - Not the email address's local part, or a password containing it — the first guess anyone
 *    makes about an account they know the address of.
 * Deliberately NOT: composition rules or forced rotation. NIST 800-63B advises against both; they
 * produce "Password1!" and the same password with a digit incremented.
 *
 * NOT YET APPLIED to passwords an ADMIN sets (user create, bulk import, admin reset) — those live in
 * user.controller.ts and are wired separately. Admin-set passwords are temporary by design anyway:
 * the account is flagged and must change it at first sign-in.
 */
import { AppError } from "../middleware/error.js";
import { COMMON_PASSWORDS } from "./common-passwords.js";

export const PASSWORD_MIN_LENGTH = 8;
/** bcrypt's input limit. Counted in UTF-8 bytes, because that is what bcrypt counts. */
export const PASSWORD_MAX_BYTES = 72;
/** A local part shorter than this is contained in too many unrelated passwords to be a signal. */
const MIN_LOCAL_PART_TO_CHECK = 3;

const COMMON = new Set(COMMON_PASSWORDS);

/** The part of an address a person is likely to reuse: before the `@`, and before any `+tag`. */
function emailLocalPart(email: string | null | undefined): string {
  return (email ?? "").split("@")[0].split("+")[0].trim().toLowerCase();
}

/** The reason a password is refused, phrased for the person choosing it — or null when it passes. */
export function passwordPolicyProblem(password: string, context: { email?: string | null }): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
    return `Use at most ${PASSWORD_MAX_BYTES} bytes — that's 72 plain letters or digits, fewer with accented letters or emoji. Anything longer is cut off when the password is stored, so the extra characters would protect nothing.`;
  }
  const lowered = password.toLowerCase();
  if (COMMON.has(lowered)) {
    return "That's one of the most commonly used passwords, so it's among the first an attacker tries. Choose something less predictable.";
  }
  const local = emailLocalPart(context.email);
  if (local.length >= MIN_LOCAL_PART_TO_CHECK && lowered.includes(local)) {
    return "Don't build your password from your email address — it's the first thing anyone would guess.";
  }
  return null;
}

/** The same check as a guard: throws a 422 carrying the reason, for the service functions. */
export function assertPasswordPolicy(password: string, context: { email?: string | null }): void {
  const problem = passwordPolicyProblem(password, context);
  if (problem) throw new AppError(422, problem);
}
