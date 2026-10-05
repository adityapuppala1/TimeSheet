// The platform-admin console password for the local verify scripts: TS_PA_PASS, else
// PLATFORM_ADMIN_BOOTSTRAP_PASSWORD from the environment or apps/api/.env. Never a literal in a
// tracked file — a scanner reports one as a leaked credential, and it trains everyone to keep it.
import fs from "node:fs";

export function platformAdminPassword() {
  const fromEnv = process.env.TS_PA_PASS || process.env.PLATFORM_ADMIN_BOOTSTRAP_PASSWORD;
  if (fromEnv) return fromEnv;
  const file = fs.existsSync("apps/api/.env") ? fs.readFileSync("apps/api/.env", "utf8") : "";
  const match = /^PLATFORM_ADMIN_BOOTSTRAP_PASSWORD="?([^"\n]*)"?/m.exec(file);
  if (match?.[1]) return match[1];
  throw new Error("Set TS_PA_PASS (or PLATFORM_ADMIN_BOOTSTRAP_PASSWORD in apps/api/.env) to the console password.");
}
