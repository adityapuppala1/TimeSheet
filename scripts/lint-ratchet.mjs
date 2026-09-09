#!/usr/bin/env node
/**
 * WHAT: fails when the lint warning count goes UP, per rule. Never when it goes down.
 *
 * WHY IT EXISTS. This repository deliberately runs sonarjs at `warn` rather than `error`, because
 * most of what it reports is style and driving the count to zero would mean rewriting readable code
 * to satisfy a metric. That decision is right and it has one failure mode: nothing stopped the pile
 * growing. It went from roughly 414 to 703 without a single moment where anyone decided to let it,
 * and at that size the fifty warnings that could be real bugs are indistinguishable from the six
 * hundred that are formatting opinions.
 *
 * A ratchet fixes exactly that and nothing else. The existing 703 are grandfathered; the 704th is a
 * build failure. Paying down a warning lowers the ceiling for everyone after you, automatically.
 *
 * PER RULE, NOT A TOTAL, and that is the whole design. A single number lets somebody remove a
 * nested ternary and add a slow regex and call it even — which is precisely the trade this is meant
 * to prevent, since those two warnings are not the same kind of thing at all. One is a matter of
 * taste. The other is a question about denial of service.
 *
 * HOW TO DEAL WITH A FAILURE, in order of preference:
 *   1. Fix the warning. Usually a minute, and it is why the number went up.
 *   2. If the warning is wrong for this code, suppress it AT THE LINE with a comment saying why.
 *      An `eslint-disable-next-line` with a reason is a decision somebody can review; a raised
 *      ceiling is not.
 *   3. Raise the baseline, in its own commit, with the reason in the message. That is allowed —
 *      this is a ratchet, not a wall — but it should be conspicuous rather than incidental.
 *
 * A RULE THAT DISAPPEARS ENTIRELY IS ALSO A FAILURE. If `sonarjs/slow-regex` stops being reported
 * because somebody removed the plugin, the count drops to zero and a naive ratchet celebrates. The
 * check below refuses a rule vanishing from the report unless it is also removed from the baseline,
 * so switching a rule off is a visible edit rather than a silent one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The workspace-root eslint, addressed by path.
 *
 * NOT `require.resolve("eslint/bin/eslint.js")`: eslint's `exports` map does not expose its bin, so
 * that throws ERR_PACKAGE_PATH_NOT_EXPORTED. And not `npx`, which resolves through its own rules and
 * can pick a different copy than the one `npm run lint` runs.
 */
const ESLINT_BIN = fileURLToPath(new URL("../node_modules/eslint/bin/eslint.js", import.meta.url));

/** The same three trees `npm run lint:sonar` covers. Tests, scripts and e2e are deliberately out of
 *  scope there, so they are out of scope here — a ratchet over a different set of files than the
 *  lint everyone runs would fail on a machine where the lint passed. */
const LINT_PATHS = ["apps/api/src", "apps/web/src", "packages/shared/src"];
const BASELINE_FILE = "lint-baseline.json";

const updating = process.argv.includes("--update");

function collectWarnings() {
  if (!existsSync(ESLINT_BIN)) {
    console.error(`[ratchet] eslint not found at ${ESLINT_BIN} — run \`npm install\` first.`);
    process.exit(1);
  }
  let raw;
  try {
    // eslint's own entry point, run under this node — not `npx` through a shell. `shell: true`
    // concatenates rather than escapes its arguments, which Node deprecates for exactly the reason
    // it sounds like, and npx adds a resolution step that can pick a different eslint than the one
    // `npm run lint` uses.
    raw = execFileSync(process.execPath, [ESLINT_BIN, ...LINT_PATHS, "--format", "json"], {
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024
    });
  } catch (error) {
    // eslint exits non-zero when it reports ERRORS. That is a lint failure in its own right and
    // `npm run lint` will have said so; the JSON on stdout is still complete and still worth
    // ratcheting, so it is read rather than discarded.
    raw = error.stdout;
    if (!raw) throw error;
  }

  const counts = {};
  let errors = 0;
  for (const file of JSON.parse(raw)) {
    for (const message of file.messages) {
      if (message.severity === 2) {
        errors += 1;
        continue;
      }
      const rule = message.ruleId ?? "(no rule)";
      counts[rule] = (counts[rule] ?? 0) + 1;
    }
  }
  return { counts, errors };
}

const { counts, errors } = collectWarnings();

if (updating) {
  writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify(
      { _comment: "Per-rule warning ceiling. See scripts/lint-ratchet.mjs.", rules: Object.fromEntries(Object.entries(counts).sort()) },
      null,
      2
    )}\n`,
    "utf-8"
  );
  console.log(`[ratchet] baseline updated: ${Object.values(counts).reduce((a, b) => a + b, 0)} warnings across ${Object.keys(counts).length} rules.`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf-8")).rules;
const regressions = [];
const improvements = [];

for (const [rule, ceiling] of Object.entries(baseline)) {
  const now = counts[rule];
  if (now === undefined) {
    regressions.push(`${rule}: no longer reported at all (baseline ${ceiling}) — was the rule switched off? Remove it from ${BASELINE_FILE} in the same commit if that was deliberate.`);
    continue;
  }
  if (now > ceiling) regressions.push(`${rule}: ${now} (ceiling ${ceiling}, +${now - ceiling})`);
  else if (now < ceiling) improvements.push(`${rule}: ${now} (was ${ceiling}, -${ceiling - now})`);
}
for (const [rule, now] of Object.entries(counts)) {
  if (!(rule in baseline)) regressions.push(`${rule}: ${now} — a rule with no ceiling. Add it to ${BASELINE_FILE} deliberately, or fix the warnings.`);
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`[ratchet] ${total} warnings, ${errors} errors, across ${Object.keys(counts).length} rules.`);

for (const line of improvements) console.log(`[ratchet] improved — ${line}`);

if (regressions.length > 0) {
  console.error("");
  for (const line of regressions) console.error(`[ratchet] REGRESSION — ${line}`);
  console.error("");
  console.error("[ratchet] Fix the warning, or suppress it at the line with a reason, or raise the");
  console.error(`[ratchet] ceiling on purpose: node scripts/lint-ratchet.mjs --update (commit ${BASELINE_FILE} with why).`);
  process.exit(1);
}

if (improvements.length > 0) {
  console.log("");
  console.log(`[ratchet] Warnings went down. Run \`node scripts/lint-ratchet.mjs --update\` to lower the ceiling so it stays down.`);
}
