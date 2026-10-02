/**
 * A second lint pass, TYPE-AWARE, with exactly one rule: no floating promises in apps/web
 * (`npm run lint:promises`, part of `npm run lint`).
 *
 * WHY: SonarQube's S9383 ("promises must be awaited, end with .catch, or be marked with void")
 * needs type information to know what is a promise, and the main pass (eslint.config.mjs) has none
 * — so it could never see one, and 280 accumulated before anybody noticed. None of them was a bug
 * (cache refreshes and navigations that cannot usefully reject), which is exactly why nothing
 * forced the question; this makes the next one visible the moment it is written.
 *
 * WHY A SEPARATE FILE: giving the MAIN pass type information would change what dozens of sonarjs
 * rules report and slow every run, and the warning ratchet (scripts/lint-ratchet.mjs) is calibrated
 * on that pass as it is. This one is ~20s, has one rule, and fails on any hit.
 *
 * How to fix a hit, without changing behaviour:
 *   - a plain function call or an async IIFE  ->  `void navigate("/x")`, `void (async () => …)()`;
 *   - a method call or a `.then` chain         ->  `runInBackground(queryClient.invalidateQueries(…))`
 *     (apps/web/src/lib/run-in-background.ts — `void` on a METHOD call trips the local
 *     `sonarjs/void-use`, which cannot see types);
 *   - or, where the caller should wait for it, `await` / `return` it.
 */
import path from "node:path";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config({
  files: ["apps/web/src/**/*.{ts,tsx}"],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { projectService: true, tsconfigRootDir: path.join(import.meta.dirname, "apps/web") }
  },
  // Loaded with every rule OFF: inline `eslint-disable` comments name rules from these plugins, and
  // a rule ESLint has never heard of is an error rather than a no-op.
  plugins: { "@typescript-eslint": tseslint.plugin, sonarjs, "react-hooks": reactHooks },
  linterOptions: { reportUnusedDisableDirectives: "off" },
  rules: { "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }] }
});
