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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const result =
  process.platform === "win32"
    ? spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "make-lan-certs.ps1")], {
        stdio: "inherit"
      })
    : spawnSync("bash", [join(here, "make-lan-certs.sh")], { stdio: "inherit" });
process.exit(result.status ?? 1);
