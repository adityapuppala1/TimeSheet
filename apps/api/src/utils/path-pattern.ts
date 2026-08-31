/**
 * WHAT: the small glob dialect an admin writes into a routing rule — `RepositoryMap.pattern`
 * (matched against a finding's repository) and `ModulePathRule.pattern` (matched against its file
 * path) — and the matcher that decides whether one of them describes a given finding.
 * WHY IT IS PURE AND LIVES HERE: it is the decision that sends a vulnerability to one team rather
 * than another, so "does `apps/*` match `apps/api/x.ts`?" has to be a question a unit test can ask
 * with no database, no tenant context and no HTTP request. See tests/unit/path-pattern.test.ts.
 * WHO calls this: services/finding-routing.service.ts (once per rule, per ingest batch) and
 * controllers/finding-routing.controller.ts (to reject a pattern an admin cannot use, and to
 * answer the "test this path" dry-run).
 *
 * ── THE DIALECT ───────────────────────────────────────────────────────────────────────────────
 *
 * Four forms, chosen because they are the four people actually write for source paths:
 *
 *   `*`             any run of characters WITHIN one path segment — never crosses a `/`.
 *   `**`            any run of characters, `/` included.
 *   trailing `/`    "this directory and everything under it" (`apps/api/` matches `apps/api` and
 *                   `apps/api/src/db.ts`, and does not match `apps/apiv2/db.ts`).
 *   no wildcard     a plain PREFIX (`services/billing-` matches `services/billing-invoice.ts`).
 *
 * `**` means literally "any characters" and nothing more, so a pattern of the form
 * `a` slash `**` slash `b` needs both slashes present in the subject and does not match `a/b`.
 * That is the same behaviour the CODEOWNERS matcher in services/git-provider.service.ts has always
 * had, and agreeing with it is worth more than a stricter reading of the gitignore spec.
 *
 * ── CASE SENSITIVITY: SENSITIVE, EVERYWHERE ───────────────────────────────────────────────────
 *
 * `src/Billing.ts` and `src/billing.ts` are two different files on every Linux host a scanner runs
 * on, and routing one of them to the wrong team because a comparison folded case would be a silent
 * wrong answer. `deriveFindingFingerprint` already preserves case in a path for the same reason.
 *
 * THE CONSEQUENCE, and it is the important half: this decision is only true if no database query
 * ever makes the same comparison. MySQL's default collation is case-INSENSITIVE, so a
 * `WHERE pattern LIKE …` would quietly disagree with this file. That is why
 * finding-routing.service.ts loads the rules and matches them here rather than filtering in SQL —
 * the same argument the verification verdict makes for comparing tool names outside its index.
 *
 * ── WHY NO REGEXP, AND NO GLOB DEPENDENCY ─────────────────────────────────────────────────────
 *
 * A pattern is admin-supplied text that runs inside an ingest request, which makes it exactly the
 * shape this repo has been bitten by before (see the `sonarjs/slow-regex` history). Compiling
 * globs to a RegExp turns `*a*a*a*a*b` into a chain of unbounded quantifiers whose backtracking is
 * polynomial in the subject length — the escaping can be made perfect and the blow-up is still
 * there, because it is the quantifiers and not the metacharacters that cost.
 *
 * So this does not compile to a RegExp at all. It simulates the pattern as an automaton over a
 * boolean array of reachable positions: every token costs one linear pass, so the total work is
 * bounded by `pattern length × subject length` with NO backtracking of any kind. There is no
 * pathological input, only a bigger one, and both ends are capped below anyway. Escaping stops
 * being a question because nothing is ever interpreted as a regex.
 *
 * ── TOTALITY ──────────────────────────────────────────────────────────────────────────────────
 *
 * `compilePathPattern` returns null for a pattern it cannot use and never throws. Callers treat
 * null as "this rule never matches" and say so once, in a log line, rather than failing the ingest
 * that happened to carry the finding. A misconfigured rule must cost a routing decision, not a
 * scan's worth of findings.
 */

/** Longer than any real path rule and equal to `ModulePathRule.pattern`'s column width, so a
 *  pattern that fits in the database is a pattern this will consider. */
export const PATH_PATTERN_MAX_LENGTH = 500;

/**
 * How many wildcards one pattern may contain.
 *
 * Not a performance cliff — the matcher has no cliff — but a bound on total work and, more
 * usefully, a bound on nonsense: no rule anybody means to write needs twenty wildcards, so a
 * pattern with more of them is a mistake worth reporting rather than evaluating.
 */
export const PATH_PATTERN_MAX_WILDCARDS = 20;

type PatternToken = { kind: "literal"; text: string } | { kind: "star" } | { kind: "globstar" };

export interface CompiledPathPattern {
  /** The pattern as written, after trimming — carried so a log line can name the rule's own text. */
  source: string;
  tokens: PatternToken[];
  /** The pattern ended in `/`: match this directory and everything beneath it. */
  directory: boolean;
  /** The pattern has no wildcard and no trailing `/`: match anything starting with it. */
  prefix: boolean;
}

/**
 * The one spelling of a path this app compares against.
 *
 * Two CI runners check the same repository out to two absolute paths, and SARIF reports a third
 * form again — see `deriveFindingFingerprint`'s own normaliser for the full argument, which this
 * mirrors. What matters here is that a PATTERN and a PATH are put through the same function, so an
 * admin who writes `/apps/api/` and a scanner that reports `apps\api\db.ts` still meet.
 * Case is deliberately untouched.
 */
export function normalisePathForMatching(value: string): string {
  return value
    .trim()
    .replace(/^file:\/\//i, "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\//, "");
}

/**
 * Splits a pattern into literal runs and wildcards, collapsing each run of `*` into a single
 * token: one star is segment-local, two or more cross segments. Collapsing is what stops
 * `*****` from becoming five tokens that each need their own pass.
 *
 * Returns null when the pattern carries more wildcards than `PATH_PATTERN_MAX_WILDCARDS`.
 */
function tokenise(pattern: string): PatternToken[] | null {
  const tokens: PatternToken[] = [];
  let literal = "";
  let wildcards = 0;

  for (let i = 0; i < pattern.length; ) {
    if (pattern[i] !== "*") {
      literal += pattern[i];
      i += 1;
      continue;
    }
    let run = 0;
    while (i < pattern.length && pattern[i] === "*") {
      run += 1;
      i += 1;
    }
    if (literal.length > 0) {
      tokens.push({ kind: "literal", text: literal });
      literal = "";
    }
    tokens.push(run >= 2 ? { kind: "globstar" } : { kind: "star" });
    wildcards += 1;
    if (wildcards > PATH_PATTERN_MAX_WILDCARDS) return null;
  }
  if (literal.length > 0) tokens.push({ kind: "literal", text: literal });
  return tokens;
}

/**
 * Prepares a pattern for matching, or returns NULL if it cannot be used at all — empty, longer
 * than the column that stores it, or more wildcards than anybody means. Never throws: the caller
 * is an ingest request, and a rule somebody typed badly must cost that rule and nothing else.
 */
export function compilePathPattern(rawPattern: string): CompiledPathPattern | null {
  if (typeof rawPattern !== "string") return null;
  const source = rawPattern.trim();
  if (source.length === 0 || source.length > PATH_PATTERN_MAX_LENGTH) return null;

  const normalised = normalisePathForMatching(source);
  const directory = normalised.endsWith("/");
  const body = directory ? normalised.slice(0, -1) : normalised;
  // `/` on its own, or a pattern that normalised away to nothing. "Everything" is a rule an admin
  // can express with `**`; an empty one is far more likely to be a typo than an intent.
  if (body.length === 0) return null;

  const tokens = tokenise(body);
  if (!tokens) return null;

  const prefix = !directory && tokens.every((token) => token.kind === "literal");
  return { source, tokens, directory, prefix };
}

/** Consuming a fixed run of characters: each reachable position either spells it out or does not. */
function stepLiteral(positions: boolean[], subject: string, text: string): boolean[] {
  const next = new Array<boolean>(positions.length).fill(false);
  for (let p = 0; p + text.length < positions.length; p += 1) {
    if (positions[p] && subject.startsWith(text, p)) next[p + text.length] = true;
  }
  return next;
}

/**
 * Consuming a wildcard. `crossesSeparator` is the ONLY difference between `**` and `*`, and it is
 * the whole difference: `active` means "a run opened at some reachable position is still open", and
 * for `*` a `/` closes every open run.
 */
function stepWildcard(positions: boolean[], subject: string, crossesSeparator: boolean): boolean[] {
  const next = new Array<boolean>(positions.length).fill(false);
  let active = false;
  for (let q = 0; q < positions.length; q += 1) {
    if (!crossesSeparator && q > 0 && subject[q - 1] === "/") active = false;
    if (positions[q]) active = true;
    if (active) next[q] = true;
  }
  return next;
}

/**
 * Which subject positions the pattern can have consumed up to, after each token in turn.
 *
 * One boolean array, one linear pass per token, no recursion and no backtracking — see this file's
 * header for why that shape was chosen over a compiled RegExp. `positions[q]` means "some prefix of
 * the tokens consumed exactly `subject[0..q)`".
 */
function reachablePositions(tokens: PatternToken[], subject: string): boolean[] {
  let positions = new Array<boolean>(subject.length + 1).fill(false);
  positions[0] = true;

  for (const token of tokens) {
    if (token.kind === "literal") positions = stepLiteral(positions, subject, token.text);
    else positions = stepWildcard(positions, subject, token.kind === "globstar");
    // Nothing reachable means nothing downstream can become reachable; stop rather than sweeping
    // the remaining tokens over an all-false array.
    if (!positions.includes(true)) return positions;
  }
  return positions;
}

/** Matches an already-compiled pattern. Compiling once and matching many times is the point: an
 *  ingest batch of 500 findings evaluates the same handful of rules 500 times. */
export function matchCompiledPathPattern(compiled: CompiledPathPattern, rawSubject: string): boolean {
  const subject = normalisePathForMatching(rawSubject);
  if (subject.length === 0) return false;

  // A wildcard-free pattern is a prefix, which needs no automaton at all.
  if (compiled.prefix) {
    const literal = compiled.tokens[0];
    return literal.kind === "literal" && subject.startsWith(literal.text);
  }

  const positions = reachablePositions(compiled.tokens, subject);
  if (!compiled.directory) return positions[subject.length];
  // "This directory and everything under it": the pattern must have consumed a whole path segment,
  // so it ends either at the end of the subject or exactly on a separator. Landing mid-segment is
  // how `apps/api/` would otherwise match `apps/apiv2/db.ts`.
  return positions.some((reached, q) => reached && (q === subject.length || subject[q] === "/"));
}

/** Compile-and-match in one call, for callers holding a pattern they will use once — the dry-run
 *  and the tests. An uncompilable pattern matches nothing, exactly as it does at ingest. */
export function matchesPathPattern(pattern: string, subject: string): boolean {
  const compiled = compilePathPattern(pattern);
  return compiled ? matchCompiledPathPattern(compiled, subject) : false;
}
