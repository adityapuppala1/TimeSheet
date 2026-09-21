#!/usr/bin/env node
/**
 * WHAT: the production-dependency vulnerability gate CI runs, replacing a bare
 * `npm audit --omit=dev --audit-level=high`.
 *
 * WHY IT IS NOT JUST `npm audit`: a bare audit has exactly two settings — pass, or block the whole
 * pipeline — and no way to say "we looked at this one, it is not reachable here, and there is no
 * upstream fix to take". The first advisory with no available fix therefore turns the gate
 * permanently red, and a permanently-red gate is one people learn to skip. That is the same failure
 * mode `sonar-project.properties` and `eslint.config.mjs` both argue against, so this file takes
 * the same shape: everything blocks by default, exceptions are written down with a reason, and the
 * exception itself is checked.
 *
 * THE PART THAT MATTERS: an accepted advisory that has SINCE BEEN FIXED is a failure too. Without
 * that, an allowlist only ever grows — entries outlive the problem, nobody dares delete one, and
 * the list quietly becomes a way of not looking. Here, when an entry stops matching anything, the
 * gate fails and tells you to delete it.
 *
 * Usage:  node scripts/audit-gate.mjs            (production deps, high+ — what CI runs)
 *         node scripts/audit-gate.mjs --dev      (include dev dependencies, for a local sweep)
 */
import { execSync } from "node:child_process";

/** Severities that block. Anything below is reported by `npm audit` and not gated on. */
const BLOCKING = new Set(["high", "critical"]);

/**
 * Advisories reviewed and accepted, each with the reasoning that made it acceptable.
 *
 * An entry earns its place by answering one question: can input an attacker controls reach the
 * vulnerable code IN THIS APPLICATION? "Probably fine" is not an answer — say which call site was
 * read. Delete the entry the moment an upstream fix exists; the gate below will insist.
 */
const ACCEPTED = [
  // EMPTY, and that is the healthy state. The one long-lived entry here was `deepmerge-ts`
  // (GHSA-ggr8-5vv4-36mx), accepted through 2026-08-21 with the reasoning that neither path to it
  // — @prisma/config reading prisma.config.ts, html-to-text merging caller options — carries
  // attacker input, and that no fix was takeable because @prisma/config pins 7.1.5 exactly.
  //
  // Closed 2026-09-21, and NOT the way the entry predicted. Prisma still pins 7.1.5; what changed
  // is that a root `overrides` to `deepmerge-ts ^8.0.2` was tried and then PROVEN rather than
  // assumed: `prisma validate` on both schemas, `prisma migrate status` and `prisma generate`
  // through the overridden config loader. The risk the entry weighed ("forcing Prisma's loader off
  // a pinned version") is the right risk to weigh; it is just answerable by running the loader.
  // `image-size` went the same way (pptxgenjs declares it and never loads it — its Node branch
  // requires a misspelled `sizeof` — and the PPTX export was rebuilt to prove it).
  //
  // The bar for adding an entry back: say which call site you read, and why the input that reaches
  // it cannot be attacker-controlled. "No fix available" on its own is a reason to look harder at
  // an override first.
];

const includeDev = process.argv.includes("--dev");
const args = ["audit", "--json", ...(includeDev ? [] : ["--omit=dev"])];

// One literal command string through execSync, rather than execFileSync with an args array.
// Windows npm is `npm.cmd`, which Node 20+ refuses to spawn without a shell (EINVAL) — and passing
// an ARGS ARRAY with `shell: true` is what Node deprecated in DEP0190, because a shell concatenates
// arguments instead of escaping them. A single string sidesteps both, and every part of it is a
// literal from this file, so there is nothing to escape in the first place.
let report;
try {
  // `npm audit` exits non-zero WHENEVER it finds anything, so a non-zero exit is not an error —
  // the report on stdout is. execSync throws on non-zero, hence reading stdout off the error.
  report = execSync(`npm ${args.join(" ")}`, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
} catch (error) {
  report = error.stdout;
  if (!report) {
    console.error("[audit] npm audit produced no report:", error.message);
    process.exit(2);
  }
}

let parsed;
try {
  parsed = JSON.parse(report);
} catch {
  console.error("[audit] npm audit did not return JSON. Raw output:\n" + report.slice(0, 2000));
  process.exit(2);
}

/** Every distinct advisory id in the report, with the packages it was reached through. */
const found = new Map();
for (const [name, vuln] of Object.entries(parsed.vulnerabilities ?? {})) {
  if (!BLOCKING.has(vuln.severity)) continue;
  for (const via of vuln.via ?? []) {
    if (typeof via !== "object" || !via.url) continue;
    const id = via.url.split("/").pop();
    if (!found.has(id)) found.set(id, { severity: via.severity ?? vuln.severity, title: via.title, packages: new Set() });
    found.get(id).packages.add(name);
  }
}

const acceptedById = new Map(ACCEPTED.map((entry) => [entry.id, entry]));
const blocking = [...found].filter(([id]) => !acceptedById.has(id));
const stale = ACCEPTED.filter((entry) => !found.has(entry.id));

for (const [id, info] of found) {
  if (!acceptedById.has(id)) continue;
  const entry = acceptedById.get(id);
  console.log(`[audit] accepted ${id} (${entry.package}, reviewed ${entry.reviewed}) — reached via ${[...info.packages].join(", ")}`);
  for (const line of entry.why) console.log(`[audit]   ${line}`);
}

if (stale.length > 0) {
  console.error("\n[audit] FAIL — these accepted advisories no longer appear in the report:");
  for (const entry of stale) console.error(`[audit]   ${entry.id} (${entry.package}) — upstream fixed it; delete this entry from scripts/audit-gate.mjs.`);
  console.error("[audit] An allowlist nobody prunes stops being a review and becomes a blindfold.\n");
  process.exit(1);
}

if (blocking.length > 0) {
  console.error(`\n[audit] FAIL — ${blocking.length} unreviewed high/critical advisor${blocking.length === 1 ? "y" : "ies"}:`);
  for (const [id, info] of blocking) {
    console.error(`[audit]   ${id}  ${info.severity.toUpperCase()}  ${info.title ?? ""}`);
    console.error(`[audit]     reached through: ${[...info.packages].join(", ")}`);
  }
  console.error("\n[audit] Fix it (`npm audit fix`, or a version bump), or — if it is genuinely not");
  console.error("[audit] reachable here and has no takeable fix — add it to ACCEPTED in");
  console.error("[audit] scripts/audit-gate.mjs with the call site you read and why it is safe.\n");
  process.exit(1);
}

const counts = parsed.metadata?.vulnerabilities ?? {};
console.log(
  `\n[audit] PASS — no unreviewed high/critical advisories in ${includeDev ? "all" : "production"} dependencies ` +
    `(report totals: ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low).`
);
