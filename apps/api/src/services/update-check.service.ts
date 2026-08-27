/**
 * WHAT: asks GitHub whether a newer TimeSphere release exists, and remembers the answer.
 *
 * WHY SERVER-SIDE rather than the browser calling GitHub directly: one server asking once an hour
 * serves every user from cache; a thousand browsers asking individually hit GitHub's 60/hr
 * unauthenticated rate limit before lunch, and each request would leak the workspace's existence
 * to a third party from every employee's machine rather than from one host an operator chose.
 *
 * PRIVACY: the check is a single unauthenticated GET to api.github.com for this repo's releases.
 * Nothing about the installation — version, org count, usage — is sent anywhere; GitHub sees an
 * IP fetch a public page. Deployments that must not call out at all set UPDATE_CHECK=off, and the
 * failure mode is silence: no banner, never an error in anyone's way.
 *
 * WHAT GITHUB IS AUTHORITATIVE FOR, and what it is NOT: it answers "is there something NEWER than
 * me", because the CD pipeline builds and tags images on `v*.*.*` tags and `update.sh` checks that
 * tag out — the artefact this reads is the artefact the updater installs. It is NOT the source of
 * the release HISTORY: a version exists in the product the moment it is cut in CHANGELOG.md and
 * stamped into VERSION, which is days earlier than somebody pushing the tag, and earlier still
 * than somebody writing the GitHub Release. That is why `withBundledHistory` builds the list from
 * this build's own CHANGELOG.md and lets GitHub enrich it, rather than the other way round.
 */
import { appVersion } from "../config/version.js";
import { getBundledReleases } from "./changelog-releases.service.js";

/** Owner/repo, overridable for forks. Kept as a plain env read rather than joining env.ts's
 *  validated schema: a bad value here should degrade to "no update info", never block boot.
 *  Exported because it also decides the release links in the bundled-changelog history, and two
 *  copies of "which repo is this" is how those links end up pointing somewhere else. */
export const REPO = process.env.UPDATE_CHECK_REPO?.trim() || "adityapuppala1/TimeSheet";
const DISABLED = (process.env.UPDATE_CHECK ?? "on").toLowerCase() === "off";
/** Optional fine-grained PAT (read-only Contents is enough) so a PRIVATE repo's releases are
 *  visible — anonymous calls to a private repo 404. Absent = anonymous, exactly as before. */
const TOKEN = process.env.UPDATE_CHECK_TOKEN?.trim() || null;

/** An hour. Releases happen weekly at most; checking faster only spends rate limit. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/**
 * How many releases of history the What's-new page gets.
 *
 * RAISED FROM 15, which the 3.6.0 release crossed — and the way it announced itself is the reason
 * this comment exists: the page silently stopped showing v1.0.0. Nothing broke, no error appeared,
 * and a "Release history" that quietly drops its oldest entry is the kind of small dishonesty this
 * product is otherwise careful about. A test comparing the page against CHANGELOG.md caught it.
 *
 * 40 rather than "no limit": the cap exists so a decade-old install does not ship a thousand-entry
 * payload to every page load, and that reasoning is still sound. 40 is roughly four years at this
 * release cadence, and the same test will fail again before anyone is misled.
 */
const RELEASE_HISTORY_LIMIT = 40;

export interface ReleaseInfo {
  version: string;
  name: string;
  /** Markdown, straight from the GitHub release body. Rendered client-side through the app's
   *  existing sanitizer path — treated as untrusted content like any other remote text. */
  notes: string;
  publishedAt: string | null;
  url: string;
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  /** True only when latest is a STRICTLY newer semver — a dev build ahead of the last release
   *  must not nag its own developer to "upgrade" backwards. */
  updateAvailable: boolean;
  checkedAt: string | null;
  checkEnabled: boolean;
  releases: ReleaseInfo[];
  /** Where `releases` came from: "changelog" = this build's bundled CHANGELOG.md alone (no live
   *  data, so blind to anything newer than this build), "github" = every listed version was also
   *  known to GitHub, "mixed" = the bundle contributed versions GitHub has not been told about
   *  yet (the normal state between cutting a release and pushing its tag), null = no history at
   *  all. The UI states the source rather than letting bundled history masquerade as a live feed. */
  releasesSource: "github" | "changelog" | "mixed" | null;
}

let cache: { fetchedAt: number; releases: ReleaseInfo[] } | null = null;
let inFlight: Promise<ReleaseInfo[]> | null = null;

/** Strict semver compare. Returns >0 when a > b. Pre-release suffixes are ignored on purpose —
 *  this product tags plain x.y.z, and inventing ordering rules for suffixes it never uses would
 *  be speculation with failure modes. */
export function compareSemver(a: string, b: string): number {
  const parse = (value: string) => value.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [aMajor = 0, aMinor = 0, aPatch = 0] = parse(a);
  const [bMajor = 0, bMinor = 0, bPatch = 0] = parse(b);
  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
}

/** One authenticated-or-not GitHub GET, with the headers this check always sends. */
function githubFetch(path: string): Promise<Response> {
  return fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "timesphere-update-check",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
    },
    signal: AbortSignal.timeout(10_000)
  });
}

/**
 * TAGS, when there are no Releases.
 *
 * WHY THIS EXISTS: the CD pipeline builds and publishes on a `v*.*.*` TAG. Creating the GitHub
 * *Release* object on top of it is a separate, manual step — and until somebody does it, every
 * running installation is told it is up to date while a newer version has in fact shipped. That is
 * the worst possible failure direction for an update check: silent, and wrong in the reassuring
 * direction.
 *
 * A tag carries no notes, which is exactly what the bundled-CHANGELOG history below already
 * handles. So this answers "is there something newer" from the artefact that always exists, and
 * the notes come from where they already came from. Tagging is now sufficient; a Release is a
 * nicety that adds the written notes.
 */
async function fetchTagsAsReleases(): Promise<ReleaseInfo[]> {
  const response = await githubFetch(`tags?per_page=${RELEASE_HISTORY_LIMIT}`);
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);

  const rows = (await response.json()) as Array<{ name?: string }>;
  return rows
    .filter((row) => /^v?\d+\.\d+\.\d+$/.test(row.name ?? ""))
    .map((row) => ({
      version: (row.name ?? "").replace(/^v/, ""),
      name: row.name ?? "",
      // Deliberately empty rather than invented. `withBundledFallback` fills notes from this
      // build's own CHANGELOG where it can, and a version with no notes is far better than a
      // version nobody is told about.
      notes: "",
      publishedAt: null,
      url: `https://github.com/${REPO}/releases/tag/${row.name}`
    }));
}

async function fetchReleases(): Promise<ReleaseInfo[]> {
  const response = await githubFetch(`releases?per_page=${RELEASE_HISTORY_LIMIT}`);
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);

  const rows = (await response.json()) as Array<{
    tag_name?: string;
    name?: string;
    body?: string;
    published_at?: string;
    html_url?: string;
    draft?: boolean;
    prerelease?: boolean;
  }>;

  const releases = rows
    // Drafts aren't shipped and prereleases aren't for operators — offering either as "the
    // update" would point update.sh at an image the CD pipeline may never have built.
    .filter((row) => !row.draft && !row.prerelease && /^v?\d+\.\d+\.\d+$/.test(row.tag_name ?? ""))
    .map((row) => ({
      version: (row.tag_name ?? "").replace(/^v/, ""),
      name: row.name?.trim() || (row.tag_name ?? ""),
      notes: row.body ?? "",
      publishedAt: row.published_at ?? null,
      url: row.html_url ?? `https://github.com/${REPO}/releases`
    }));

  // No Releases published yet, but the CD pipeline tags every version it builds. Reading the tags
  // means an installation learns about a new version from the artefact that always exists, rather
  // than being told it is up to date until somebody remembers to write release notes.
  if (releases.length === 0) return fetchTagsAsReleases();
  return releases;
}

/**
 * The cached answer. Never throws: a failed or disabled check reports "no information", because
 * an update BANNER must never become an update ERROR in front of someone doing their job.
 */
export async function getUpdateStatus(): Promise<UpdateStatus> {
  const base: UpdateStatus = {
    currentVersion: appVersion.version,
    latestVersion: null,
    updateAvailable: false,
    checkedAt: cache ? new Date(cache.fetchedAt).toISOString() : null,
    checkEnabled: !DISABLED,
    releases: cache?.releases ?? [],
    releasesSource: cache?.releases.length ? "github" : null
  };
  if (DISABLED) return withBundledHistory(base);

  if (!cache || Date.now() - cache.fetchedAt > CHECK_INTERVAL_MS) {
    // Single-flight so a burst of settings-page loads right after cache expiry produces one
    // GitHub request, not one per viewer.
    inFlight ??= fetchReleases()
      .then((releases) => {
        cache = { fetchedAt: Date.now(), releases };
        return releases;
      })
      .finally(() => {
        inFlight = null;
      });
    try {
      await inFlight;
    } catch {
      // Offline, rate-limited, or GitHub down: keep whatever we knew before. Stale release info
      // is strictly better than none, and none is still not an error.
    }
  }

  const releases = cache?.releases ?? [];
  // The HIGHEST version GitHub knows, not the first row it happened to return. /releases comes
  // back newest-first, but /tags does not promise any ordering at all — and "latest" is the value
  // the update banner and `update.sh` hang off, so it must not depend on GitHub's list order.
  const latest = releases.reduce<string | null>(
    (best, release) => (best === null || compareSemver(release.version, best) > 0 ? release.version : best),
    null
  );
  return withBundledHistory({
    ...base,
    latestVersion: latest,
    updateAvailable: latest != null && compareSemver(latest, appVersion.version) > 0,
    checkedAt: cache ? new Date(cache.fetchedAt).toISOString() : null,
    releases,
    releasesSource: releases.length ? "github" : null
  });
}

/** Which origins the merged list actually drew on — see `UpdateStatus.releasesSource`. */
function sourceOf(releases: ReleaseInfo[], knownToGithub: Set<string>): UpdateStatus["releasesSource"] {
  if (knownToGithub.size === 0) return "changelog";
  return releases.every((release) => knownToGithub.has(release.version)) ? "github" : "mixed";
}

/**
 * The release HISTORY the What's-new page renders: this build's own CHANGELOG.md as the base list,
 * with whatever GitHub said merged over it.
 *
 * WHY THE CHANGELOG IS THE BASE and not the fallback it started life as. Cutting a release is one
 * edit to CHANGELOG.md plus one to VERSION; pushing the tag and writing the GitHub Release are
 * separate, later, manual steps. An earlier revision mapped over GITHUB's list and only filled in
 * missing notes per version — so any release whose tag had not been pushed was simply ABSENT from
 * the page, notes and all. Observed on this repo: tags existed for 1.0.0, 1.1.0, 2.0.0 and 2.3.0
 * only, so 2.1.0, 2.2.0 and the RUNNING 2.4.0 were invisible in Release history while their notes
 * sat in the very bundle the page was served from — and because 2.3.0 was still GitHub's newest,
 * the page also confidently said "Up to date". Deriving the list from the changelog means cutting
 * a release cannot leave the page stale, whatever anyone forgets to push afterwards.
 *
 * WHAT GITHUB STILL ADDS: versions NEWER than this build (a bundle cannot know about those), real
 * release/tag URLs, publish timestamps, and notes an author edited on the Release after shipping.
 *
 * WHAT THIS DELIBERATELY DOES NOT TOUCH: `updateAvailable`/`latestVersion`. A build's own changelog
 * cannot know about anything newer than itself, so answering "is there an update" from it would be
 * a lie with a straight face — see the caller, which computes both from GitHub data only.
 */
function withBundledHistory(status: UpdateStatus): UpdateStatus {
  const bundled = getBundledReleases(REPO);
  if (bundled.length === 0) return status;

  const knownToGithub = new Set(status.releases.map((release) => release.version));
  const byVersion = new Map(bundled.map((release) => [release.version, release]));

  // GitHub answered, but possibly thinly: the tags fallback returns real versions with EMPTY
  // notes, and a Release somebody published in a hurry can be empty too. So this is a per-field
  // merge, not a replacement — an earlier revision returned early on any non-empty GitHub list,
  // and the moment tags became visible every release's notes VANISHED from the page, replaced by
  // "No notes were written", while the notes were in this build's own CHANGELOG the whole time.
  for (const remote of status.releases) {
    const local = byVersion.get(remote.version);
    byVersion.set(
      remote.version,
      local
        ? {
            ...remote,
            notes: remote.notes.trim() ? remote.notes : local.notes,
            // A bare tag has no human name; the changelog's heading does. A real GitHub Release
            // title (anything beyond the tag string itself) always wins.
            name:
              remote.name && remote.name !== `v${remote.version}` && remote.name !== remote.version
                ? remote.name
                : local.name,
            publishedAt: remote.publishedAt ?? local.publishedAt
          }
        : remote
    );
  }

  // Newest first by SEMVER, because the list now has two origins and neither one's ordering can
  // be trusted to interleave with the other's. `slice` keeps the panel bounded the same way the
  // GitHub query is.
  const releases = [...byVersion.values()]
    .sort((a, b) => compareSemver(b.version, a.version))
    .slice(0, RELEASE_HISTORY_LIMIT);

  return { ...status, releases, releasesSource: sourceOf(releases, knownToGithub) };
}
