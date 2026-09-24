#!/usr/bin/env node
/**
 * Keep the N most recent releases in GHCR and delete the rest — safely.
 *
 * WHY THIS EXISTS RATHER THAN `actions/delete-package-versions`. Every off-the-shelf pruner offers
 * "delete untagged versions", and on this registry that is a loaded gun. buildx pushes each release
 * as an OCI *index*, and that index's children — the linux/amd64 image, plus the provenance
 * attestation buildx attaches by default — are separate package versions carrying NO tag of their
 * own. They are referenced by digest from the tagged parent and look exactly like garbage.
 *
 * Measured on this registry, 2026-09-24: of 675 untagged versions across the two packages, 558 were
 * children of a tagged release. A "delete untagged" pass would have broken
 * `docker pull ghcr.io/<owner>/timesheet-api:<version>` for every release from 2.0.0 to 5.5.0 —
 * while reporting success, because the tag survives with nothing underneath it.
 *
 * So this script never reasons from "is it tagged". It resolves what every KEPT version references
 * and protects those digests explicitly; only what nothing points at is removed.
 *
 * WHAT IT KEEPS
 *   - the `--keep` most recent releases by semver (default 2),
 *   - any version carrying a floating tag (`latest`, `main`) whatever its age, because the Helm
 *     chart's default `image.tag` is `latest` and deleting it breaks a default install,
 *   - every child manifest of all of the above.
 *
 * USAGE
 *   node scripts/prune-ghcr.mjs --owner <user> --package timesheet-api [--keep 2] [--apply]
 *
 * Dry run unless `--apply` is passed: it prints what it would delete and exits 0.
 * Needs a token with `read:packages` + `delete:packages` (GITHUB_TOKEN in Actions, or `gh auth`).
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const OWNER = arg("owner");
const PACKAGE = arg("package");
const KEEP = Number(arg("keep", "2"));
const APPLY = args.includes("--apply");
/** Tags that float: whatever they point at is kept regardless of age. */
const FLOATING = new Set(["latest", "main"]);

if (!OWNER || !PACKAGE) {
  console.error("usage: prune-ghcr.mjs --owner <user> --package <name> [--keep 2] [--apply]");
  process.exit(2);
}

const token = process.env.GITHUB_TOKEN || execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", ...(init.headers ?? {}) }
  });
  if (!res.ok && res.status !== 204) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

/** The registry, not the API: only it knows which digests a manifest references. */
const registryManifest = async (ref) => {
  const res = await fetch(`https://ghcr.io/v2/${OWNER}/${PACKAGE}/manifests/${ref}`, {
    headers: {
      Authorization: `Bearer ${Buffer.from(token).toString("base64")}`,
      Accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json"
      ].join(",")
    }
  });
  return res.ok ? res.json() : null;
};

/** Sorts newest-first. A version with no semver tag sorts last and is never counted as a release. */
const semverOf = (tags) => {
  for (const t of tags) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(t);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return null;
};

const versions = [];
for (let page = 1; ; page += 1) {
  const batch = await api(`users/${OWNER}/packages/container/${PACKAGE}/versions?per_page=100&page=${page}`);
  if (!batch.length) break;
  for (const v of batch) versions.push({ id: v.id, digest: v.name, created: v.created_at, tags: v.metadata?.container?.tags ?? [] });
  if (batch.length < 100) break;
}

const releases = versions.filter((v) => semverOf(v.tags)).sort((a, b) => {
  const [x, y] = [semverOf(a.tags), semverOf(b.tags)];
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
});
const floating = versions.filter((v) => v.tags.some((t) => FLOATING.has(t)));

const keep = new Map();
for (const v of releases.slice(0, KEEP)) keep.set(v.id, `release ${v.tags.filter((t) => semverOf([t])).join("/")}`);
for (const v of floating) if (!keep.has(v.id)) keep.set(v.id, `floating tag ${v.tags.filter((t) => FLOATING.has(t)).join("/")}`);

// Everything a kept version points at is kept too. This is the whole point of the script.
const protectedDigests = new Set();
for (const id of keep.keys()) {
  const v = versions.find((x) => x.id === id);
  const m = await registryManifest(v.digest);
  if (m && Array.isArray(m.manifests)) for (const c of m.manifests) protectedDigests.add(c.digest);
}
for (const v of versions) {
  if (!keep.has(v.id) && protectedDigests.has(v.digest)) keep.set(v.id, "child of a kept release");
}

const doomed = versions.filter((v) => !keep.has(v.id));
console.log(`${PACKAGE}: ${versions.length} versions — keeping ${keep.size}, deleting ${doomed.length}`);
for (const [id, why] of keep) {
  const v = versions.find((x) => x.id === id);
  if (!why.startsWith("child")) console.log(`  KEEP  ${v.created.slice(0, 10)}  ${why}`);
}
console.log(`  KEEP  ${[...keep.values()].filter((w) => w.startsWith("child")).length} child manifests of the above`);

if (!APPLY) {
  console.log(`\nDRY RUN — nothing deleted. Re-run with --apply to remove ${doomed.length} versions.`);
  process.exit(0);
}

let ok = 0;
let failed = 0;
for (const v of doomed) {
  try {
    await api(`users/${OWNER}/packages/container/${PACKAGE}/versions/${v.id}`, { method: "DELETE" });
    ok += 1;
  } catch (err) {
    failed += 1;
    if (failed <= 3) console.error(`  ! ${v.id}: ${String(err).slice(0, 120)}`);
  }
}
console.log(`  deleted ${ok}, failed ${failed}`);
process.exit(failed ? 1 : 0);
