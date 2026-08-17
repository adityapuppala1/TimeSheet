/**
 * WHAT: tells everybody, once, that their workspace is now running a new version of TimeSphere —
 * an in-app bell notification linking straight at that release on /app/whats-new.
 *
 * WHY IT EXISTS: before this, discovering what an upgrade changed required knowing that
 * /app/whats-new exists and going to look. Release notes are written for the people using the app;
 * a set of notes nobody is told about is a document, not a release. The profile menu's dot
 * (web/src/lib/whats-new-seen.ts) is per-browser and easy to miss, and it cannot say WHICH version
 * arrived. This can, and it survives clearing site data.
 *
 * WHY IN-APP ONLY, NEVER EMAIL: "the product was upgraded" is news, not correspondence. Emailing
 * every user of every tenant on every release is the kind of send that gets a sending domain
 * filtered, and no category in the email role matrix covers product announcements — so
 * `release.published` is registered with `null` in notify.service.ts's SETTINGS_FIELD, which makes
 * the absence of an email leg structural rather than a decision someone remembered to make.
 *
 * WHO SEES IT: everybody active, deliberately without a role or entitlement gate. This mirrors the
 * What's-new page's own split (documented in its header): the NOTES are for everyone, because they
 * describe features people use; only the "here is how to upgrade" card is admin-only, and this
 * notification carries none of that.
 *
 * WHY IT READS THE BUNDLED CHANGELOG rather than asking GitHub: the notes it points at are the ones
 * that shipped inside this build, and they exist the moment a release is cut. Waiting on the GitHub
 * tag would mean the announcement arrives days after the upgrade, or never on a private/air-gapped
 * installation — the same reason the What's-new history is changelog-derived (update-check.service).
 *
 * DEDUPE — and why there is no new table for it. The `Notification` rows ARE the record: the link
 * carries the version (`/app/whats-new?release=2.4.0`), so "has this workspace already been told
 * about this version" is one indexed-ish lookup for that exact link, and the answer survives
 * restarts, redeploys and rollbacks for free. A version is announced at most once per workspace;
 * people who join later never receive it, which is correct — it is news, and it was not news when
 * they arrived.
 *
 * ON A BRAND-NEW INSTALL the first boot announces the version being installed. That is a single row
 * per seeded user pointing at "what this version does", which is a fair thing for a first-run
 * workspace to have in its bell, and the alternative (suppressing it) requires a "have we ever
 * announced anything" baseline that no fresh database can distinguish from "we upgraded".
 *
 * WHO CALLS THIS: server.ts at boot, detached, once per process — wrapped in `runForEveryOrg`
 * because a boot-time job has no request to resolve a tenant from.
 */
import { appVersion } from "../config/version.js";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { getBundledReleases } from "./changelog-releases.service.js";
import { dispatchInAppToMany } from "./notify.service.js";
import { REPO } from "./update-check.service.js";

/** The deep link the bell row opens. The `release` param is what WhatsNew.tsx expands on arrival,
 *  and it is also the dedupe key — one purpose does not compromise the other. */
export function whatsNewLink(version: string): string {
  return `/app/whats-new?release=${encodeURIComponent(version)}`;
}

/**
 * One workspace's announcement. Returns how many people were told, so a caller (and the boot log)
 * can tell "already announced" apart from "nobody to tell".
 */
export async function announceRunningReleaseForOrg(): Promise<{ version: string; notified: number } | null> {
  const version = appVersion.version;

  // The notes must EXIST before anyone is pointed at them. A build whose version is missing from
  // its own bundled CHANGELOG.md (a dev build, "0.0.0-dev", or a VERSION bumped before the
  // changelog section was written) would otherwise send everybody to a page with nothing on it.
  // apps/api/tests/unit/changelog-releases.service.test.ts fails the build when a real release
  // gets into that state; this is the runtime half of the same rule.
  const release = getBundledReleases(REPO).find((candidate) => candidate.version === version);
  if (!release) return null;

  const link = whatsNewLink(version);
  const alreadyAnnounced = await prisma.notification.findFirst({
    where: { category: "release.published", link },
    select: { id: true }
  });
  if (alreadyAnnounced) return null;

  const recipients = await prisma.user.findMany({
    where: { status: "ACTIVE", deletedAt: null },
    select: { id: true }
  });
  if (recipients.length === 0) return null;

  const named = release.name && release.name !== `v${version}` ? release.name : null;
  const notified = await dispatchInAppToMany({
    userIds: recipients.map((user) => user.id),
    category: "release.published",
    title: `TimeSphere v${version} is now running`,
    body: named
      ? `${named} — open What's new to read everything this release changed.`
      : `This workspace has been updated. Open What's new to read everything this release changed.`,
    link
  });

  return { version, notified };
}

/**
 * Every workspace, once per process. Never throws: an announcement that fails must not be able to
 * take a boot down, and the next restart tries again because the dedupe lookup is the only state.
 */
export async function announceRunningRelease(
  runForEveryOrg: (label: string, fn: () => Promise<void>) => Promise<void>
): Promise<void> {
  await runForEveryOrg("release-announce", async () => {
    const result = await announceRunningReleaseForOrg();
    if (result) {
      console.log(
        `[release-announce] ${requireTenantContext().orgSlug}: told ${result.notified} user(s) about v${result.version}`
      );
    }
  });
}
