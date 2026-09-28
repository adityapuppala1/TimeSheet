/**
 * Which files are allowed to read the deployment-wide `APP_BASE_URL`.
 *
 * WHY A TEST OVER THE SOURCE TEXT, which is an unusual shape and is chosen deliberately: the defect
 * this prevents is not a wrong value, it is a wrong VARIABLE at one of two dozen call sites, and it
 * is invisible on the deployment everybody develops on. In single-org mode `tenantBaseUrl()` and
 * `env.APP_BASE_URL` are the same string, so a regression here typechecks, passes every behavioural
 * test, renders a correct-looking email, and only fails for customers who are not the default
 * workspace. No assertion about behaviour catches that. An assertion about which files reach for
 * the global address does.
 *
 * WHAT IT PREVENTS, MEASURED. A password reset requested at `Host: acme.example.test` wrote its
 * token to the `acme_corp` database (0 → 1 rows) while the default org's table stayed at 4 — and the
 * link in the email was built from `APP_BASE_URL`, whose hostname resolves to the DEFAULT workspace.
 * `resetPassword` then searched the wrong database and told the person their link had expired.
 *
 * HOW TO CHANGE THIS LIST. Adding a file is a decision, not a chore: it means "a link built here is
 * about the DEPLOYMENT, not about a workspace". Every entry below carries the reason it qualifies,
 * and a new one without a reason is the thing this test is trying to stop.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

/**
 * Files that legitimately read the deployment-wide address, and why.
 *
 * The reasons fall into four kinds, and the distinction is what makes the list reviewable:
 *   - it IS the configuration (defines, inspects, or reports the value);
 *   - the link is about the deployment, not a workspace (platform console, marketing);
 *   - the URL is registered with a third party and must be one fixed string;
 *   - the token in the link is self-describing, so the link works from any hostname.
 */
const ALLOWED: Record<string, string> = {
  "config/env.ts": "defines and resolves the value",
  "config/deployment-check.ts": "its whole job is inspecting this setting at boot",
  "config/origins.ts": "the CORS allow-list is about the deployment's own origin",
  "server.ts": "prints the boot-time configuration report",

  "services/workspace-directory.service.ts": "defines workspaceUrlForSlug and tenantBaseUrl — the fallback lives here",

  "services/sso.service.ts":
    "the OAuth redirect_uri is registered at Google/Microsoft and must be ONE exact string; the tenant is recovered from the signed state, not the callback host (controllers/sso.controller.ts#finishSsoLogin)",
  "controllers/settings.controller.ts": "displays that same registered redirect_uri so an admin can paste it into the IdP",
  "services/git-provider.service.ts": "the git provider's OAuth callback is likewise registered once with the provider",

  "services/retention.service.ts":
    "its reactivate/feedback links carry a SIGNED token containing the org id (signPublicToken), so the route resolves the workspace from the token and the link works from any hostname",

  "controllers/auth.controller.ts":
    "the workspace-finder mail is cross-tenant by definition — it exists to tell somebody which workspace addresses to try, so a single workspace's address would be the wrong answer",

  "services/platform-mail.service.ts": "platform-admin mail, sent by the deployment about itself",
  "services/platform-alerts.service.ts": "links to /platform-admin, which is not a workspace",
  "services/sales-lead.service.ts": "marketing follow-up, sent before any workspace exists",
  "controllers/platform-admin.controller.ts": "the routing readout REPORTS the configured value",
  "controllers/billing.controller.ts": "mentions it in a comment only"
};

/** Every file under src/ that mentions the variable, as a posix-style path relative to src/. */
function filesMentioningAppBaseUrl(): string[] {
  const { globSync } = require("node:fs") as typeof import("node:fs");
  return globSync("**/*.ts", { cwd: SRC })
    .map((p: string) => p.split("\\").join("/"))
    .filter((p: string) => !p.startsWith("generated/"))
    .filter((p: string) => readFileSync(resolve(SRC, p), "utf8").includes("APP_BASE_URL"))
    .sort();
}

describe("emailed links are addressed to the workspace they are about", () => {
  it("finds the readers at all, so the rest of this file is not asserting over an empty list", () => {
    // The guard on the guard. A glob that silently matches nothing would make every assertion
    // below pass while checking absolutely nothing — the exact failure mode this file is about.
    const found = filesMentioningAppBaseUrl();
    expect(found.length).toBeGreaterThan(8);
    expect(found).toContain("config/env.ts");
  });

  it("has no reader outside the allow-list", () => {
    const unexpected = filesMentioningAppBaseUrl().filter((p) => !(p in ALLOWED));
    expect(
      unexpected,
      "These files read the deployment-wide APP_BASE_URL. If the link is about a WORKSPACE, use " +
        "tenantBaseUrl() (or workspaceUrlForSlug(slug) where no tenant context is active — see " +
        "workers/trial-lifecycle.worker.ts, which builds two of its three links outside withOrgTenant). " +
        "If it really is about the deployment, add it to ALLOWED with the reason."
    ).toEqual([]);
  });

  it("has no stale allow-list entry", () => {
    // Keeps the list honest in the other direction: an exemption for a file that no longer reads the
    // variable is a reason nobody can check, and it would quietly re-permit a future regression there.
    const readers = new Set(filesMentioningAppBaseUrl());
    expect(Object.keys(ALLOWED).filter((p) => !readers.has(p))).toEqual([]);
  });

  it("gives every exemption a reason", () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, `${file} needs a real reason, not a placeholder`).toBeGreaterThan(20);
    }
  });

  it("keeps the password-reset link — the one that was measurably broken — off the global address", () => {
    // Named explicitly rather than left to the allow-list, because this is the call site that was
    // proven wrong against a running server, and a regression here is a silent lockout.
    const source = readFileSync(resolve(SRC, "services/auth.service.ts"), "utf8");
    const resetLine = source.split("\n").find((line) => line.includes("/reset-password?token="));
    expect(resetLine).toBeDefined();
    expect(resetLine).toContain("tenantBaseUrl()");
    expect(resetLine).not.toContain("APP_BASE_URL");
  });
});
