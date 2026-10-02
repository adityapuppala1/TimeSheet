/**
 * Which secrets the production boot check in server.ts#assertProductionSafety looks at, and the one
 * relationship between them it refuses. Lives here rather than inline in server.ts so a test can
 * pin it — server.ts cannot be imported without starting a server.
 *
 * PLATFORM_ADMIN_JWT_SECRET WAS NOT ON THE LIST, and it is the most powerful of the four: it signs
 * the tokens of a console that can drop any customer's database. A placeholder or a hand-typed value
 * booted fine in production while the same value in JWT_ACCESS_SECRET refused to.
 */
interface SecretEnv {
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  PLATFORM_ADMIN_JWT_SECRET: string;
  ENCRYPTION_KEY: string;
}

/** Every secret the entropy check in server.ts runs over, by name. */
export function productionSecretsToCheck(env: SecretEnv): ReadonlyArray<readonly [string, string]> {
  return [
    ["JWT_ACCESS_SECRET", env.JWT_ACCESS_SECRET],
    ["JWT_REFRESH_SECRET", env.JWT_REFRESH_SECRET],
    ["PLATFORM_ADMIN_JWT_SECRET", env.PLATFORM_ADMIN_JWT_SECRET],
    ["ENCRYPTION_KEY", env.ENCRYPTION_KEY]
  ];
}

/**
 * The console secret must not BE a tenant secret.
 *
 * The issuer/audience pair already stops a tenant token verifying as a console token, so sharing a
 * value is not an instant exploit. It does mean the separation the console was designed around is
 * one leak deep instead of two: whoever reads the tenant secret off any tenant-side host or log has
 * the console's too, and the console's is the one that mints owners.
 */
export function reusedSecretProblem(env: SecretEnv): string | null {
  for (const name of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"] as const) {
    if (env.PLATFORM_ADMIN_JWT_SECRET === env[name]) {
      return `PLATFORM_ADMIN_JWT_SECRET is the same value as ${name} — the console's signing secret must be its own.`;
    }
  }
  return null;
}
