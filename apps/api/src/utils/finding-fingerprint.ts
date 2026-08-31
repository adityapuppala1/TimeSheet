/**
 * WHAT: derives a stable identity for one security finding, so the same problem reported by
 * tonight's scan is recognised as the one last night's scan reported rather than inserted again.
 * WHY IT IS PURE AND LIVES HERE: everything downstream trusts this value — deduplication, the
 * occurrence counter, and the run-to-run comparison the verification work is built on all key off
 * it. A recipe that important has to be testable on its own, with no database, no tenant context
 * and no HTTP request, so that "does a ten-line edit change the fingerprint?" is a question a unit
 * test can ask directly. See tests/unit/finding-fingerprint.test.ts.
 * WHO calls this: controllers/devops-webhook.controller.ts, once per ingested finding.
 *
 * ── NOT `Ticket.errorFingerprint` ─────────────────────────────────────────────────────────────
 *
 * There is a second, unrelated fingerprint in this codebase and the two must never be compared,
 * merged, or read across:
 *
 *   `Ticket.errorFingerprint` identifies a CRASH. It is supplied by the caller (the /error-events
 *   route in devops-webhook.controller.ts), stored on the TICKET, written once and never updated,
 *   and exists so repeat crashes land on one ticket instead of opening a new one each time.
 *
 *   This one identifies a STATIC FINDING. It is DERIVED here (never supplied by the caller — a
 *   scanner must not be able to assert that two findings are the same problem), stored on the
 *   FINDING, and recomputed on every ingest.
 *
 * Different subject, different owner, different lifetime. They only share a word.
 */
import crypto from "node:crypto";

/**
 * How many source lines collapse into one bucket.
 *
 * WHY A WINDOW AND NOT THE LINE. A vulnerability does not move because somebody added an import at
 * the top of the file. Keyed on the exact line, an edit ten lines above the finding makes it look
 * like a brand-new problem: the old row stops being seen (and, once the verification work lands,
 * would be declared fixed) while a duplicate is created for the same code. Nothing changed but the
 * whitespace above it.
 *
 * WHAT THIS TRADE COSTS, stated plainly rather than discovered later: bucketing by division has
 * boundaries, and a drift that crosses one still produces a new fingerprint. With a window of 50,
 * a 10-line drift breaks the match roughly one time in five instead of every time. It is a large
 * improvement, not a guarantee, and no window size makes it a guarantee — the only thing that
 * would is a content hash of the surrounding source, which this app does not have (it never sees
 * the repository, only what a scanner posts about it).
 *
 * WHY 50 AND NOT 500: the window is also what keeps two DIFFERENT instances of the same rule in
 * the same file apart. Widen it far enough and every SQL-injection warning in a 400-line file
 * collapses into one finding, and the count a security team works from is quietly wrong in the
 * more dangerous direction.
 */
const LINE_WINDOW = 50;

/**
 * The recipe version, carried in the value itself.
 *
 * Changing how a fingerprint is derived without saying so is the one failure this whole file
 * cannot recover from: every existing finding would stop matching its own future reports, silently
 * and all at once. With the prefix, a changed recipe is VISIBLE — old rows keep `v1:` values, new
 * rows get `v2:`, the two never collide, and one scan's worth of findings look new before things
 * settle. That is still a real cost, so bump this only deliberately, and never edit the derivation
 * below without bumping it.
 */
const FINGERPRINT_VERSION = "v1";

export interface FindingFingerprintInput {
  /** The scanner's name, e.g. "semgrep". Two tools reporting the same line are two findings — they
   *  have different false-positive rates and get triaged separately. */
  tool: string;
  /** The rule's own identifier when the tool reports one (SARIF's `ruleId`). */
  ruleId?: string | null;
  /** The weakness class, e.g. "CWE-89". Preferred over `ruleId` — see `ruleIdentityOf`. */
  cwe?: string | null;
  filePath?: string | null;
  lineNumber?: number | null;
}

/**
 * Normalises the path a scanner reported into something two different CI runners agree on.
 *
 * The same repository checked out by two runners produces two absolute paths
 * (`/home/runner/work/api/api/src/db.ts` vs `D:\a\api\api\src\db.ts`), and SARIF reports it a
 * third way again (`file:///home/runner/work/api/api/src/db.ts`). Left alone, one repository
 * scanned from two agents would produce two of every finding.
 *
 * What is fixed here is the part that is unambiguously formatting: the URI scheme, backslashes,
 * `./` prefixes, duplicated slashes, and a leading slash. What is NOT fixed is the checkout root
 * itself — `/home/runner/work/api/api/` is indistinguishable from a real directory called `home`
 * without knowing where the repository begins, and this app never sees the repository. A CI job
 * that reports repo-relative paths (which every example in
 * docs/SECURITY_DEVOPS_INTEGRATIONS.md does) gets stable fingerprints; one that reports absolute
 * paths gets fingerprints stable per runner layout. Case is deliberately preserved: paths are
 * case-sensitive on the Linux hosts this scans.
 */
function normalisePath(filePath: string): string {
  return filePath
    .trim()
    .replace(/^file:\/\//i, "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\//, "");
}

/**
 * The rest of the journey to a repo-relative path — the part `normalisePath` above deliberately
 * refuses to guess at, done where the caller DOES know the answer.
 *
 * WHY THIS EXISTS SEPARATELY. `normalisePath` fixes formatting and stops. It cannot remove a
 * checkout root, because `/home/runner/work/api/api/` is indistinguishable from a real directory
 * called `home` when all you have is the string. That is fine for SARIF, whose producers report
 * repo-relative paths. It is NOT fine for the two ingest paths this function was added for:
 * `eslint --format json` reports ABSOLUTE paths from whatever machine ran it, and SonarQube reports
 * `projectKey:src/thing.ts`. Feed either in raw and the same file scanned by two runners — or by the
 * same runner after a workspace-directory change — produces two different fingerprints. Two
 * fingerprints means two rows for one problem, which means dedup does nothing, which means the
 * verification ladder can never conclude anything: the "next scan" it waits for reports a finding it
 * cannot recognise as the one it is waiting on. A path difference upstream is a silent, total
 * failure of everything downstream.
 *
 * WHAT IT DOES, in order:
 *   1. `normalisePath` — scheme, backslashes, duplicate and leading slashes, `./`.
 *   2. A Windows drive prefix (`C:/…`), which step 1 cannot strip because it strips a LEADING
 *      slash and a drive letter comes before one. Handled here rather than in `normalisePath`
 *      because changing that function changes every fingerprint already in every database, and the
 *      version prefix exists precisely so that never happens by accident.
 *   3. The caller's own checkout root, when it supplied one — normalised the same way first, so
 *      `D:\a\api\api` and `/d/a/api/api` both strip the path they were the root of.
 *
 * Returns "" when nothing is left, which the caller should read as "no usable path" and pass on as
 * undefined — the same signal an absent path gives.
 */
export function toRepoRelativePath(filePath: string, rootPath?: string | null): string {
  const stripDrive = (value: string) => value.replace(/^[a-z]:\//i, "");
  const normalised = stripDrive(normalisePath(filePath));
  if (!rootPath) return normalised;

  // `endsWith`/`slice` rather than a `/\/+$/` replace: `normalisePath` has already collapsed runs of
  // slashes, so at most one can remain and there is nothing for a quantifier to backtrack over —
  // which also keeps this off the ReDoS lint's radar for a pattern that never needed to be one.
  const normalisedRoot = stripDrive(normalisePath(rootPath));
  const root = normalisedRoot.endsWith("/") ? normalisedRoot.slice(0, -1) : normalisedRoot;
  if (!root) return normalised;
  // Only a true directory-boundary prefix counts. Without the trailing slash, a root of `src/app`
  // would also claim `src/application/x.ts` and hand back `lication/x.ts` — a corrupted path is
  // worse than an unstripped one, because it looks plausible.
  return normalised.startsWith(`${root}/`) ? normalised.slice(root.length + 1) : normalised;
}

/**
 * WHICH IDENTITY WINS, and why CWE comes first: a CWE is the same across tool versions and even
 * across tools, while a rule id is a scanner's internal name and gets renamed between releases
 * (`javascript.express.security.audit.xss` → something else) — which would make every finding in a
 * workspace look new the day their scanner updated. The rule id is the fallback for the many tools
 * that do not tag CWEs at all.
 *
 * Returns null when the tool gave us neither, which is the caller's signal that this finding has
 * no derivable identity.
 */
function ruleIdentityOf(input: FindingFingerprintInput): string | null {
  const cwe = input.cwe?.trim();
  // Upper-cased so "cwe-89" and "CWE-89" from two tools are one identity; a CWE id has no
  // case-sensitive component.
  if (cwe) return cwe.toUpperCase();
  const ruleId = input.ruleId?.trim();
  if (ruleId) return ruleId;
  return null;
}

/**
 * Returns the fingerprint, or NULL when this finding has no stable identity to derive one from.
 *
 * Null is a legitimate, expected answer — not an error and not something to log about. A DAST
 * finding has no file path; a hand-written payload may carry neither a CWE nor a rule id. The
 * caller's contract is to fall back to creating a row unconditionally, exactly as it always did,
 * rather than dropping a finding it cannot identify. Losing a real vulnerability because we could
 * not name it would be a far worse failure than storing it twice.
 *
 * WHAT GOES INTO THE HASH, in order: the tool, the rule identity, the normalised path, and the
 * line WINDOW. What deliberately does NOT: the title, the description and the severity, all of
 * which a scanner rewords or re-scores between versions without the underlying problem changing —
 * and the repository and branch, which are the OUTER key the ingest matches on separately, so that
 * the same fingerprint can be compared across branches rather than being a different value on each.
 *
 * The payload is `JSON.stringify` of an array rather than fields glued together with a separator,
 * because JSON escapes its own contents: no choice of delimiter can be smuggled in by a path or a
 * rule id that happens to contain it.
 */
export function deriveFindingFingerprint(input: FindingFingerprintInput): string | null {
  const tool = input.tool?.trim().toLowerCase();
  if (!tool) return null;

  const ruleIdentity = ruleIdentityOf(input);
  if (!ruleIdentity) return null;

  const path = input.filePath ? normalisePath(input.filePath) : "";
  if (!path) return null;

  // A missing or nonsensical line number is its own bucket rather than pretending to be line 0 —
  // "the tool did not say where" and "the tool said the top of the file" are different claims.
  const lineWindow =
    typeof input.lineNumber === "number" && Number.isFinite(input.lineNumber) && input.lineNumber > 0
      ? String(Math.floor(input.lineNumber / LINE_WINDOW))
      : "none";

  const payload = JSON.stringify([tool, ruleIdentity, path, lineWindow]);
  return `${FINGERPRINT_VERSION}:${crypto.createHash("sha256").update(payload).digest("hex")}`;
}
