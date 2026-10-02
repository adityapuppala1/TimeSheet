/**
 * The bootstrap platform admin's password — what prisma/control/seed.ts gives the first OWNER.
 *
 * WHY THIS EXISTS (C1). The seed used to create `platform-admin@timesphere.local` with
 * `PlatformAdmin@12345` on every install, production included, and both installers printed it. A
 * password in the repository is in every fork and every CI log, so a fresh production install started
 * with an OWNER anybody could sign in as, and nothing on the server made them change it.
 *
 * THE RULE, in the order it is applied:
 *  1. PLATFORM_ADMIN_BOOTSTRAP_PASSWORD set → used as given, NOT flagged. The installers generate one
 *     and print it once; local development and CI pass the known dev value so the dev scripts and the
 *     e2e suite can sign in. Somebody who chose a password does not need to be told to choose one.
 *  2. ...unless it IS the public dev value and NODE_ENV is production. "Explicitly chosen" is not an
 *     honest description of a value that is in every clone, so it is flagged for rotation regardless.
 *  3. Unset → a strong random password, printed once by the seed and flagged, so the console admits
 *     the account to nothing but "choose your own password" until it has.
 *
 * Kept out of the seed file so it can be tested: the seed is a script with a database on the far end.
 */
import { randomBytes } from "node:crypto";
import { AppError } from "../middleware/error.js";
import { SEEDED_PLATFORM_ADMIN_PASSWORD } from "./platform-admin-auth.service.js";

export interface BootstrapPassword {
  password: string;
  source: "explicit" | "generated";
  /** Whether the created account must rotate it before the console admits it anywhere else. */
  mustChangePassword: boolean;
  /** Something the seed should print beside the result. */
  warning?: string;
}

/** The minimum `/auth/change-password` accepts. A bootstrap value shorter than the floor an operator
 *  is held to for their own password would be the weakest password on the platform. */
const MIN_EXPLICIT_LENGTH = 12;

/** 18 random bytes as base64url: 24 characters, ~144 bits, nothing a shell or a JSON body chokes on. */
export function generateBootstrapPassword(): string {
  return randomBytes(18).toString("base64url");
}

export function resolveBootstrapPassword(
  env: { PLATFORM_ADMIN_BOOTSTRAP_PASSWORD?: string; NODE_ENV?: string },
  generate: () => string = generateBootstrapPassword
): BootstrapPassword {
  const explicit = env.PLATFORM_ADMIN_BOOTSTRAP_PASSWORD;
  // Whitespace-only is "unset": a blanked `.env` line must not become a password of three spaces.
  if (explicit && explicit.trim()) {
    if (explicit.length < MIN_EXPLICIT_LENGTH) {
      throw new AppError(422, `PLATFORM_ADMIN_BOOTSTRAP_PASSWORD must be at least ${MIN_EXPLICIT_LENGTH} characters — the same floor the console holds every operator's own password to.`);
    }
    if (env.NODE_ENV === "production" && explicit === SEEDED_PLATFORM_ADMIN_PASSWORD) {
      return {
        password: explicit,
        source: "explicit",
        mustChangePassword: true,
        warning: "PLATFORM_ADMIN_BOOTSTRAP_PASSWORD is the public development password. The account is created, but the console will make you change it at first sign-in."
      };
    }
    return { password: explicit, source: "explicit", mustChangePassword: false };
  }
  return { password: generate(), source: "generated", mustChangePassword: true };
}
