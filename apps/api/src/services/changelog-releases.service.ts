/**
 * WHAT: release history parsed from the CHANGELOG.md that ships INSIDE this build — the
 * self-contained source the What's-new page falls back to when GitHub has nothing to offer.
 *
 * WHY THIS EXISTS: the update-check reads GitHub Releases, which is the right source for "is
 * there something NEWER than me" — but it goes dark for exactly the deployments this product
 * courts: private repos (anonymous API calls 404), air-gapped installs (no outbound network),
 * and any repo where nobody has published a formal release yet. Meanwhile every build already
 * carries its own complete, versioned history in CHANGELOG.md — the same file CONTRIBUTING.md's
 * release process copies release bodies FROM. Parsing it locally means the Release-history
 * panel always has the truth about every version up to and including the running one.
 *
 * WHAT THIS DELIBERATELY CANNOT DO: announce updates. A build's own changelog cannot know about
 * versions released after it was built, so `updateAvailable` stays GitHub-only — this fallback
 * fills the HISTORY, never the future.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReleaseInfo } from "./update-check.service.js";

/**
 * The file lives at the REPO root, and the api process's cwd differs by context: `apps/api` under
 * `npm run dev -w`, `/app` inside the Docker image (where the Dockerfile COPYs it next to
 * VERSION). Both candidates are tried; a build somehow missing the file degrades to an empty
 * history, never an error — same posture as the GitHub check itself.
 */
const CANDIDATES = [resolve(process.cwd(), "CHANGELOG.md"), resolve(process.cwd(), "../../CHANGELOG.md")];

/** Parsed once per process — the file is baked into the build and cannot change under us. */
let cache: ReleaseInfo[] | null = null;

/**
 * Heading dialects this changelog actually uses, all of which must parse:
 *   ## 1.0.0 — 2026-07-29                      (version — date)
 *   ## 1.1.0 — 2026-08-03                      (version — date)
 *   ## 2.0.0 — the planning layer — 2026-08-06 (version — name — date)
 * Split the post-version remainder on em/en dashes; whichever segment looks like a date IS the
 * date, the rest is the release name.
 */
const HEADING_RE = /^## (\d+\.\d+\.\d+)(?:\s*[—–-]\s*(.*))?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseChangelogReleases(markdown: string, repo: string): ReleaseInfo[] {
  const lines = markdown.split(/\r?\n/);
  const releases: ReleaseInfo[] = [];
  let current: { version: string; name: string; date: string | null; body: string[] } | null = null;

  const push = () => {
    if (!current) return;
    releases.push({
      version: current.version,
      name: current.name || `v${current.version}`,
      notes: current.body.join("\n").trim(),
      // Midday UTC, not midnight: the changelog records a DATE, and rendering midnight UTC in a
      // western-hemisphere browser shows the previous day — a wrong date invented from a right one.
      publishedAt: current.date ? `${current.date}T12:00:00.000Z` : null,
      url: `https://github.com/${repo}/releases`
    });
  };

  for (const line of lines) {
    const match = line.match(HEADING_RE);
    if (match) {
      push();
      const segments = (match[2] ?? "")
        .split(/\s*[—–]\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
      const date = segments.find((s) => DATE_RE.test(s)) ?? null;
      const name = segments.filter((s) => !DATE_RE.test(s)).join(" — ");
      current = { version: match[1], name, date, body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  push();
  return releases;
}

/** The bundled history, newest first (document order — the changelog is newest-first by rule). */
export function getBundledReleases(repo: string): ReleaseInfo[] {
  if (cache) return cache;
  for (const path of CANDIDATES) {
    try {
      cache = parseChangelogReleases(readFileSync(path, "utf8"), repo);
      return cache;
    } catch {
      /* try the next location */
    }
  }
  cache = [];
  return cache;
}
