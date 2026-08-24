import { defineConfig } from "vitest/config";

/**
 * WHAT: the web workspace's unit-test runner. Small on purpose — this is not a component-testing
 * harness, and it is not trying to become one.
 *
 * WHY IT EXISTS AT ALL: `src/lib/safe-html.ts` is a security control (it is the ONLY sanitizer for
 * two of its callers — Ask AI's model-authored markdown, and the What's-new page's release notes
 * fetched from GitHub), and it had no test, because DOMPurify needs a DOM and `apps/api`'s vitest
 * runs in `node`. A control with no test is a control that silently stops working; that gap was
 * recorded in the security assessment and this closes it.
 *
 * `jsdom` AND NOT `happy-dom`, which this config was first written against — do not "optimise" it
 * back. Under happy-dom, DOMPurify strips EVERY element: `sanitize("<p>x</p>", {ALLOWED_TAGS:["p"]})`
 * returns the bare string `"x"`, with no hooks installed and no configuration involved. The tests
 * still went mostly green, because assertions of the form "the dangerous thing is absent" pass
 * beautifully when the sanitizer eats the whole document — which is exactly the shape of false pass
 * a security test must not have. jsdom is what DOMPurify supports and tests against; the extra
 * install weight is the price of the suite meaning what it says.
 */
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "jsdom",
    globals: false,
    restoreMocks: true,
    testTimeout: 10_000
  }
});
