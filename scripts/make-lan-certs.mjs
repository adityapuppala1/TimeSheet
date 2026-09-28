/**
 * Cross-platform dispatcher for `npm run certs` — picks the right cert script for the OS, so
 * the README can teach ONE command instead of two paths with per-OS flags.
 *
 * WHY CERTS NEED A COMMAND AT ALL, on every new machine: the TLS pair under apps/web/certs/ is
 * a private key, git-ignored by design (and excluded from Docker build contexts for the same
 * reason). A fresh clone therefore always serves http — that is a property of the clone, not a
 * bug — until this machine mints its own certificate. See scripts/make-lan-certs.{ps1,sh}.
 */
import { spawnSync } from "node:child_process";

/**
 * Extra hostnames, forwarded verbatim: `npm run certs -- acme.localhost default.localhost`.
 *
 * Needed because a workspace subdomain has to be NAMED in the certificate - a "*.localhost"
 * wildcard is issued by mkcert and then refused by every verifier, since a wildcard may not cover a
 * whole top-level label. See the note in make-lan-certs.{ps1,sh}.
 */
const extraHosts = process.argv.slice(2);
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const result =
  process.platform === "win32"
    ? spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "make-lan-certs.ps1"), ...extraHosts], {
        stdio: "inherit"
      })
    : spawnSync("bash", [join(here, "make-lan-certs.sh"), ...extraHosts], { stdio: "inherit" });
process.exit(result.status ?? 1);
