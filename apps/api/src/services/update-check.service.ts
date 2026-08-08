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
 * WHY GITHUB RELEASES AS THE SOURCE OF TRUTH: the CD pipeline already builds and tags images on
 * `v*.*.*` tags, so a release IS a tag — this reads the same artefact the updater installs, and
 * the release body (markdown notes) is what the What's-new page renders. One process, no second
 * changelog to forget.
 */
import { appVersion } from "../config/version.js";
import { getBundledReleases } from "./changelog-releases.service.js";

/** Owner/repo, overridable for forks. Kept as a plain env read rather than joining env.ts's
 *  validated schema: a bad value here should degrade to "no update info", never block boot. */
const REPO = process.env.UPDATE_CHECK_REPO?.trim() || "adityapuppala1/TimeSheet";
const DISABLED = (process.env.UPDATE_CHECK ?? "on").toLowerCase() === "off";
/** Optional fine-grained PAT (read-only Contents is enough) so a PRIVATE repo's releases are
 *  visible — anonymous calls to a private repo 404. Absent = anonymous, exactly as before. */
const TOKEN = process.env.UPDATE_CHECK_TOKEN?.trim() || null;

/** An hour. Releases happen weekly at most; checking faster only spends rate limit. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** How many releases of history the What's-new page gets. */
const RELEASE_HISTORY_LIMIT = 15;

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
  /** Where `releases` came from: live GitHub data (has real URLs/dates), this build's own
   *  bundled CHANGELOG.md (complete history up to the running version, no knowledge of newer
   *  ones), or null when even the changelog was missing. The UI states the source rather than
   *  letting bundled history masquerade as a live feed. */
  releasesSource: "github" | "changelog" | null;
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
 * A tag carries no notes, which is exactly what the bundled-CHANGELOG fallback below already
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
  if (DISABLED) return withBundledFallback(base);

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
  const latest = releases[0]?.version ?? null;
  return withBundledFallback({
    ...base,
    latestVersion: latest,
    updateAvailable: latest != null && compareSemver(latest, appVersion.version) > 0,
    checkedAt: cache ? new Date(cache.fetchedAt).toISOString() : null,
    releases,
    releasesSource: releases.length ? "github" : null
  });
}

/**
 * When GitHub yielded nothing — private repo without a token, air-gapped install, no releases
 * published yet, check disabled — the HISTORY comes from this build's own CHANGELOG.md instead
 * of an empty panel. `updateAvailable`/`latestVersion` are left alone: a build's own changelog
 * cannot know about anything newer than itself, and inventing "you're up to date" from it would
 * be a lie with a straight face.
 */
function withBundledFallback(status: UpdateStatus): UpdateStatus {
  const bundled = getBundledReleases(REPO);
  if (bundled.length === 0) return status;

  // Nothing from GitHub at all — the bundled history IS the history.
  if (status.releases.length === 0) {
    return { ...status, releases: bundled, releasesSource: "changelog" };
  }

  // GitHub answered, but possibly thinly: the tags fallback returns real versions with EMPTY
  // notes, and a Release somebody published in a hurry can be empty too. This merge is the
  // promise fetchTagsAsReleases' comment was already making — an earlier revision returned
  // early on any non-empty list, so the moment tags became visible every release's notes
  // VANISHED from the What's-new page, replaced by "No notes were written". The notes were in
  // this build's own CHANGELOG the whole time; per-version fill is what actually keeps them.
  const byVersion = new Map(bundled.map((release) => [release.version, release]));
  const releases = status.releases.map((release) => {
    const local = byVersion.get(release.version);
    if (!local) return release;
    return {
      ...release,
      notes: release.notes.trim() ? release.notes : local.notes,
      // A bare tag has no human name; the changelog's heading does. A real GitHub Release
      // title (anything beyond the tag string itself) always wins.
      name: release.name && release.name !== `v${release.version}` && release.name !== release.version ? release.name : local.name,
      publishedAt: release.publishedAt ?? local.publishedAt
    };
  });
  return { ...status, releases };
}
