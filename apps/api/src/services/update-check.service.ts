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

/** Owner/repo, overridable for forks. Kept as a plain env read rather than joining env.ts's
 *  validated schema: a bad value here should degrade to "no update info", never block boot. */
const REPO = process.env.UPDATE_CHECK_REPO?.trim() || "adityapuppala1/TimeSheet";
const DISABLED = (process.env.UPDATE_CHECK ?? "on").toLowerCase() === "off";

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

async function fetchReleases(): Promise<ReleaseInfo[]> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=${RELEASE_HISTORY_LIMIT}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "timesphere-update-check" },
    signal: AbortSignal.timeout(10_000)
  });
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

  return rows
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
    releases: cache?.releases ?? []
  };
  if (DISABLED) return base;

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
  return {
    ...base,
    latestVersion: latest,
    updateAvailable: latest != null && compareSemver(latest, appVersion.version) > 0,
    checkedAt: cache ? new Date(cache.fetchedAt).toISOString() : null,
    releases
  };
}
