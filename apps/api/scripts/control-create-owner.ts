/**
 * Break-glass: create a second platform OWNER from the API host's shell, for an install that has
 * fewer than two (so the console's two-person rule cannot be met by anybody).
 *
 *   npm run control:create-owner -w apps/api -- --email=second@example.com --name="Second Owner" --reason="Single-owner install, need a countersigner"
 *   docker compose exec api npm run control:create-owner -w apps/api -- --email=… --name=… --reason=…
 *
 * Refuses once two active owners exist; audited; the generated password is printed ONCE and the
 * account must change it at first sign-in. See services/platform-break-glass.service.ts for why this
 * does not weaken the two-person rule.
 */
import os from "node:os";
import { controlPrisma } from "../src/config/control-prisma.js";
import { createBreakGlassOwner } from "../src/services/platform-break-glass.service.js";

function flag(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? "";
}

async function main() {
  let user = "unknown";
  try {
    user = os.userInfo().username;
  } catch {
    // Some container runtimes have no passwd entry for the uid; the hostname still says where.
  }
  const result = await createBreakGlassOwner({ email: flag("email"), name: flag("name"), reason: flag("reason"), actor: `${user}@${os.hostname()}` });
  const rule = "=".repeat(72);
  console.log(`\n${rule}`);
  console.log(`  New platform OWNER: ${result.email}`);
  console.log(`  One-time password:  ${result.temporaryPassword}`);
  console.log("  Shown ONCE and stored only as a hash. Hand it over by a channel you trust;");
  console.log("  the console makes them choose their own password before anything else.");
  console.log(`${rule}\n`);
}

main()
  .catch((error: Error) => {
    console.error(`control:create-owner: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => controlPrisma.$disconnect());
