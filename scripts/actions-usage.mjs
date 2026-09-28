#!/usr/bin/env node
/**
 * Where the GitHub Actions minutes actually went, across every repository on the account.
 *
 * WHY THIS EXISTS RATHER THAN A LINK TO THE BILLING PAGE. On 2026-09-28 this account ran out of
 * minutes mid-release: every job in a run failed in two seconds with no runner ever assigned, on
 * both Linux and Windows, for a commit whose jobs had passed an hour earlier. Working out WHY took
 * measuring, and the two obvious sources both fail:
 *
 *   - `GET /users/{user}/settings/billing/actions` needs a scope a normal `gh` login does not have.
 *   - `GET /repos/{o}/{r}/actions/runs/{id}/timing` — the endpoint built for exactly this question —
 *     answers `{"billable":{"UBUNTU":{"total_ms":0,...}}}` for this account, with a real
 *     `run_duration_ms` sitting right next to the zero. One whole script was written against it
 *     before that was noticed, which is the reason this comment exists.
 *
 * So this computes the bill the way GitHub does: each JOB's `completed_at - started_at`, rounded UP
 * to the whole minute, multiplied by the runner's rate. Nothing here is estimated.
 *
 * RATES (against the included allowance): Linux 1x, Windows 2x, macOS 10x. A private repository
 * spends the allowance; public repositories are free, and are reported separately rather than mixed
 * in, because a number that adds them together does not correspond to anything you are charged.
 *
 * USAGE
 *   node scripts/actions-usage.mjs                    # this calendar month
 *   node scripts/actions-usage.mjs --since 2026-08-01
 *   node scripts/actions-usage.mjs --owner someone --limit 400
 *
 * Needs `gh` logged in with `repo` scope. It makes one API call per workflow run, so a busy month
 * takes a minute or two.
 *
 * WHAT TO DO WITH THE OUTPUT: the per-job table is the one that decides anything. A gate in
 * `.github/workflows/ci.yml` should only be loosened or tightened against a number in it — every
 * change in that file's budget note names the measurement that justified it, and this is how those
 * were produced.
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const monthStart = () => {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
};

const SINCE = arg("since", monthStart());
const LIMIT = Number(arg("limit", "1000"));
/** How a minute on each runner counts against the allowance. */
const RATE = { ubuntu: 1, windows: 2, macos: 10 };

const gh = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
const OWNER = arg("owner", gh("user").login);

/** Runner family from the job's labels — `runs-on` is not on the job payload, the labels are. */
const runnerOf = (labels = []) => {
  const joined = labels.join(" ").toLowerCase();
  if (joined.includes("windows")) return "windows";
  if (joined.includes("macos") || joined.includes("mac-")) return "macos";
  return "ubuntu";
};

/**
 * `/user/repos` FOR YOUR OWN ACCOUNT, and `/users/{owner}/repos` only for somebody else's.
 *
 * The public listing omits private repositories entirely — which on this account is where 99% of
 * the bill lives, so the first version of this script reported a confident zero. If the totals here
 * ever look impossibly small, this is the line to suspect.
 */
const viewer = gh("user").login;
const repoPath = OWNER === viewer ? "user/repos?affiliation=owner&per_page=100&sort=pushed" : `users/${OWNER}/repos?per_page=100&sort=pushed`;
const repos = gh(repoPath).map((r) => ({ name: r.name, private: r.private }));
if (repos.length === 0) {
  console.error(`No repositories visible for ${OWNER}. Is \`gh\` logged in with the \`repo\` scope?`);
  process.exit(1);
}

const rows = [];
let scanned = 0;
for (const repo of repos) {
  for (let page = 1; ; page += 1) {
    let batch;
    try {
      batch = gh(`repos/${OWNER}/${repo.name}/actions/runs?created=%3E%3D${SINCE}&per_page=100&page=${page}`);
    } catch {
      break; // no Actions on this repo, or no access
    }
    const runs = batch.workflow_runs ?? [];
    if (!runs.length) break;
    for (const run of runs) {
      if (scanned >= LIMIT) break;
      scanned += 1;
      let jobs = [];
      try {
        jobs = gh(`repos/${OWNER}/${repo.name}/actions/runs/${run.id}/jobs?per_page=100`).jobs ?? [];
      } catch {
        continue;
      }
      for (const job of jobs) {
        // A job that never got a runner has no duration and cost nothing — which is itself the
        // signature of an exhausted allowance, and is why those runs must not inflate the total.
        if (!job.started_at || !job.completed_at) continue;
        const ms = new Date(job.completed_at) - new Date(job.started_at);
        if (ms <= 0) continue;
        const runner = runnerOf(job.labels);
        const wall = Math.ceil(ms / 60000);
        rows.push({
          repo: repo.name,
          billed: repo.private ? wall * RATE[runner] : 0,
          free: repo.private ? 0 : wall,
          wall,
          runner,
          workflow: run.name,
          job: job.name,
          ref: run.head_branch,
          day: (run.created_at ?? "").slice(0, 10)
        });
      }
    }
    if (runs.length < 100) break;
  }
}

const total = (list, key = "billed") => list.reduce((sum, r) => sum + r[key], 0);
const billedTotal = total(rows);
const rank = (key, list = rows) => {
  const m = new Map();
  for (const r of list) {
    const k = typeof key === "function" ? key(r) : r[key];
    m.set(k, (m.get(k) ?? 0) + r.billed);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const line = (v, label) => {
  const share = billedTotal ? `${String(Math.round((v / billedTotal) * 100)).padStart(3)}%` : "   -";
  console.log(`  ${String(Math.round(v)).padStart(6)} min  ${share}  ${label}`);
};

console.log(`\nActions usage for ${OWNER} since ${SINCE} — ${rows.length} jobs across ${scanned} runs\n`);
console.log(`BILLED AGAINST THE ALLOWANCE: ${Math.round(billedTotal)} minutes`);
if (total(rows, "free") > 0) console.log(`  (plus ${Math.round(total(rows, "free"))} min on PUBLIC repos, which are free and excluded above)`);
console.log(`  wall-clock across all runners: ${Math.round(total(rows, "wall"))} min\n`);

console.log("BY REPOSITORY");
for (const [k, v] of rank("repo")) if (v > 0) line(v, k);

console.log("\nBY WORKFLOW");
for (const [k, v] of rank((r) => `${r.repo} / ${r.workflow}`)) if (v >= Math.max(5, billedTotal * 0.01)) line(v, k);

console.log("\nBY JOB — the table that should decide any change to a CI gate");
for (const [k, v] of rank("job").slice(0, 12)) line(v, k);

console.log("\nBY RUNNER");
for (const [k, v] of rank("runner")) {
  const wall = total(rows.filter((r) => r.runner === k), "wall");
  line(v, `${k}  (${wall} wall-clock min x${RATE[k]})`);
}

console.log("\nBY REF");
for (const [k, v] of rank("ref").slice(0, 10)) line(v, k ?? "(none)");

console.log("\nBUSIEST DAYS");
for (const [k, v] of rank("day").slice(0, 10)) line(v, k);
console.log("");
