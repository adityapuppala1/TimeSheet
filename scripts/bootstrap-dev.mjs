/**
 * WHAT: the "make a fresh clone actually runnable" step that `npm run setup` runs before doctor.
 * Creates `apps/api/.env` from `.env.example`, mints dev TLS certs if this machine has none, and
 * — the part that matters on an UPDATE rather than a fresh install — reports any variable that
 * has since been added to `.env.example` but is missing from the `.env` you already have.
 *
 * WHY THIS EXISTS: `npm run setup` used to begin with doctor, which validates `apps/api/.env` and
 * exits telling you to go and create it. That is a correct diagnosis and a bad first-run
 * experience — the one thing every fresh clone needs was the one thing the setup command would
 * not do. Same for certificates: `npm run certs` was a separate command nobody runs until the
 * camera fails on a phone.
 *
 * WHY IT REPORTS NEW KEYS INSTEAD OF WRITING THEM: a release that adds a feature flag (the 2.1.0
 * telemetry vars are the motivating case) ships it in `.env.example`, and an existing deployment's
 * `.env` — which is deliberately NOT in git — never learns about it. The feature then looks
 * broken rather than unconfigured. Listing the gap costs nothing and is honest; silently editing
 * a file holding production credentials is not something a setup script should do uninvited, so
 * appending is opt-in via `--sync` and only ever writes COMMENTED lines.
 *
 * Safe to re-run: every step is a no-op when its output already exists. Never overwrites an
 * existing `.env`, and never regenerates a certificate you have already trusted on your devices.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = join(root, ".env.example");
const TARGET = join(root, "apps", "api", ".env");
const CERT = join(root, "apps", "web", "certs", "dev-cert.pem");
const KEY = join(root, "apps", "web", "certs", "dev-key.pem");
const SYNC = process.argv.includes("--sync");

const cyan = (m) => console.log(`\x1b[36m==>\x1b[0m ${m}`);
const warn = (m) => console.log(`\x1b[33m[warn]\x1b[0m ${m}`);
const ok = (m) => console.log(`\x1b[32m  ok\x1b[0m ${m}`);

/** Variable names on real (uncommented) assignment lines. */
function activeKeys(text) {
  return new Set(
    text
      .split(/\r?\n/)
      .map((line) => /^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1])
      .filter(Boolean)
  );
}

/** Names on commented-out assignments too — `# FOO=bar` in the example means "optional setting",
 *  which is exactly the shape every feature flag takes, so it must count as documented. */
function documentedKeys(text) {
  return new Set(
    text
      .split(/\r?\n/)
      .map((line) => /^\s*#?\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1])
      .filter(Boolean)
  );
}

if (!existsSync(EXAMPLE)) {
  warn(`No .env.example at ${EXAMPLE} — skipping env bootstrap.`);
} else if (!existsSync(TARGET)) {
  cyan("Creating apps/api/.env from .env.example ...");
  copyFileSync(EXAMPLE, TARGET);
  ok("apps/api/.env created.");
  warn("It holds PLACEHOLDER secrets and a default DATABASE_URL — open it and fill in real values.");
  warn("`npm run doctor -w apps/api` will tell you exactly which ones are wrong for this machine.");
} else {
  ok("apps/api/.env already exists — left untouched.");
  const example = readFileSync(EXAMPLE, "utf8");
  const target = readFileSync(TARGET, "utf8");
  const have = documentedKeys(target);
  const missing = [...documentedKeys(example)].filter((k) => !have.has(k));

  if (missing.length === 0) {
    ok("Every variable documented in .env.example is present in your .env.");
  } else {
    warn(`${missing.length} variable(s) added to .env.example since your .env was written:`);
    for (const k of missing) console.log(`       ${k}`);
    // Required-vs-optional matters: a missing OPTIONAL flag is a feature sitting switched off,
    // while a missing REQUIRED one will fail Zod validation at boot.
    const required = new Set(activeKeys(example));
    const missingRequired = missing.filter((k) => required.has(k));
    // "Uncommented in the example", not "will break your boot": many of these still carry a Zod
    // default in config/env.ts (DEFAULT_ORG_SLUG is one), so this is a prompt to look, not an
    // alarm. Claiming otherwise would send people chasing a variable that was never missing.
    if (missingRequired.length) {
      warn(`Of those, these are uncommented in .env.example (check whether they need a real value): ${missingRequired.join(", ")}`);
    }
    if (SYNC) {
      appendFileSync(
        TARGET,
        `\n# --- added by scripts/bootstrap-dev.mjs on ${new Date().toISOString().slice(0, 10)} ---\n` +
          `# Documented in .env.example but absent here. Commented out: uncomment what you want.\n` +
          missing.map((k) => `# ${k}=`).join("\n") +
          "\n"
      );
      ok(`Appended ${missing.length} commented placeholder(s) to apps/api/.env.`);
    } else {
      console.log("       Re-run with `--sync` to append them (commented out) to your .env.");
    }
  }
}

// Certificates are a per-machine private key, git-ignored on purpose. Regenerating one you have
// already trusted on a phone would silently break that trust, so this only ever fills a gap.
if (existsSync(CERT) && existsSync(KEY)) {
  ok("Dev TLS certificate already present — not regenerating (re-trusting is manual).");
} else {
  cyan("No dev certificate — generating one so the camera and clipboard work over https ...");
  const result = spawnSync(process.execPath, [join(root, "scripts", "make-lan-certs.mjs")], { stdio: "inherit" });
  if (result.status === 0) ok("Dev certificate created under apps/web/certs/.");
  // Advisory only: mkcert/openssl may be absent, and a machine without https is still perfectly
  // usable for everything except the camera. Failing setup over it would be disproportionate.
  else warn("Certificate generation failed — the app will serve http. Run `npm run certs` when you need https.");
}
