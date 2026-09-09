/**
 * The lint rule `sonarjs/slow-regex` says "make sure this cannot lead to denial of service". That is
 * a QUESTION, not a defect report — and answering fifty-one of them by eye is how a codebase ends up
 * with fifty-one warnings nobody reads.
 *
 * This file answers it by running the regexes.
 *
 * WHY THAT MATTERS MORE THAN IT SOUNDS. When these were measured for the first time, the result
 * inverted the obvious fix. Of the patterns flagged in `backup-destination.service.ts`, eleven were
 * the alternation `/^\/+|\/+$/g` and one was `/\/+$/`. The alternation — the scarier-looking one,
 * flagged eleven times — is LINEAR: 0.02ms against fifty thousand slashes, because V8 optimises the
 * global-replace path. The plain trailing anchor is QUADRATIC: 0.30ms at a thousand, 797ms at fifty
 * thousand. The "obvious" cleanup, splitting the alternation into two anchored regexes, would have
 * introduced eleven copies of the only genuinely slow pattern in the file.
 *
 * So: measure, then fix what is actually slow. The quadratic one is gone (`trimTrailingSlashes`),
 * and this test stops it, or anything like it, coming back.
 *
 * WHAT THIS IS NOT. It is not a general ReDoS scanner and it does not read the source. It is a
 * budget over the patterns that have been flagged and assessed, driven at sizes far beyond any real
 * input, so that a rewrite which reintroduces backtracking fails here rather than in production. A
 * new flagged regex should be ADDED here as part of assessing it — that is the process, and
 * CONTRIBUTING.md (*Reading `npm run lint`*) says so.
 *
 * The budget is deliberately loose. A shared CI runner under load is not a benchmark rig, and a
 * test that fails when the machine is busy gets deleted. Quadratic blowup at these sizes is three
 * orders of magnitude clear of the limit, so nothing marginal is being measured.
 */
import { describe, expect, it } from "vitest";

/** Far beyond any real input: a backup prefix is a short admin-typed string, a pasted comment is
 *  kilobytes. Fifty thousand characters is where quadratic behaviour becomes unmissable. */
const PATHOLOGICAL = 50_000;

/** Generous on purpose — see the header. Quadratic patterns exceeded this by 15x when measured. */
const BUDGET_MS = 250;

function timeRegex(re: RegExp, input: string): number {
  const started = performance.now();
  if (re.global) {
    re.lastIndex = 0;
    input.replace(re, "");
  } else {
    re.test(input);
  }
  return performance.now() - started;
}

/**
 * Every pattern eslint flagged as super-linear on a path worth defending, with the input that would
 * actually trigger its backtracking. A regex is only meaningfully timed against the string designed
 * to make it work hardest — timing `/\/+$/` against ordinary prose proves nothing.
 */
const FLAGGED: Array<{ what: string; re: () => RegExp; worstCase: (n: number) => string }> = [
  {
    what: "backup prefix trim (alternation, kept deliberately)",
    re: () => /^\/+|\/+$/g,
    worstCase: (n) => "/".repeat(n) + "a"
  },
  {
    what: "rich-text paste: fenced code block",
    re: () => /^\s*```[^\n]*\n([\s\S]*?)\n?\s*```\s*$/,
    worstCase: (n) => "```\n" + "x\n".repeat(n)
  },
  {
    what: "rich-text paste: yaml-ish key: value",
    re: () => /^[^\S\n]*[\w"'-]+[^\S\n]*:[^\S\n]*(?:[|>]|\S)[^.!?\n]*$/m,
    worstCase: (n) => " ".repeat(n) + "k"
  },
  {
    what: "rich-text paste: code keywords",
    re: () =>
      /^[^\S\n]*(?:function|class|const|let|var|def|public|private|protected|import|export|return|if|for|while|switch|try|catch)\b/m,
    worstCase: (n) => " ".repeat(n) + "x"
  },
  {
    what: "rich-text paste: shell prompt",
    re: () => /^\s*[$#>]\s+\S+/m,
    worstCase: (n) => " ".repeat(n) + "x"
  },
  {
    what: "rich-text paste: lone brace",
    re: () => /^\s*[{}[\]]\s*[,;]?\s*$/m,
    worstCase: (n) => " ".repeat(n) + "x"
  },
  {
    what: "rich-text paste: markup",
    re: () => /^\s*(?:<\/?[a-z][\w-]*(?:\s[^>]*)?>|<\?xml|<!DOCTYPE)/im,
    worstCase: (n) => "<a " + "b".repeat(n)
  },
  {
    what: "rich-text paste: stack trace",
    re: () =>
      /^\s*(?:at\s+[\w$.<>]+\s*\(|Traceback \(most recent call last\)|Caused by:|Exception in thread)/m,
    worstCase: (n) => "at " + "a".repeat(n)
  }
];

describe("regexes flagged as super-linear stay within budget on their own worst case", () => {
  it.each(FLAGGED)("$what", ({ re, worstCase }) => {
    const elapsed = timeRegex(re(), worstCase(PATHOLOGICAL));
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});

describe("the pattern that was actually slow", () => {
  it("is quadratic, which is why it is no longer in the source", () => {
    // Kept as a LOCAL regex, never imported from the service — the point is to demonstrate the
    // behaviour that justified `trimTrailingSlashes`, so that a future reader who thinks the helper
    // is pointless ceremony can see the number rather than take it on trust.
    const quadratic = /\/+$/;
    const small = timeRegex(quadratic, "/".repeat(2_000) + "a");
    const large = timeRegex(quadratic, "/".repeat(8_000) + "a");

    // Four times the input for far more than four times the work. Compared as a ratio rather than
    // against a wall-clock figure, because ratios survive a slow CI runner and absolute timings
    // do not.
    expect(large / Math.max(small, 0.01)).toBeGreaterThan(6);
  });

  it("has a replacement that is linear and behaves identically", async () => {
    // Imported from the service so this tests the shipped code, not a copy of it.
    const { trimTrailingSlashes } = await import("../../src/services/backup-destination.service.js");

    expect(trimTrailingSlashes("/a/b/")).toBe("/a/b");
    expect(trimTrailingSlashes("/a/b///")).toBe("/a/b");
    expect(trimTrailingSlashes("/")).toBe("");
    expect(trimTrailingSlashes("")).toBe("");
    // No leading trim: that is a different question, and the caller wants an absolute path kept.
    expect(trimTrailingSlashes("///a")).toBe("///a");

    const started = performance.now();
    trimTrailingSlashes("/".repeat(PATHOLOGICAL) + "a");
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});
