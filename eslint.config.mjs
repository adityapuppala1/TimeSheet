/**
 * WHAT: the SonarQube rule set, runnable locally and in CI without a Sonar server.
 *
 * WHY THIS EXISTS: `sonar-project.properties` has been in this repo describing how to scan it, but
 * nothing ever ran a scan — `npm run lint` was `tsc --noEmit` in both workspaces, which type-checks
 * and reports no code smells at all. So "the Sonar problems" were unknowable from inside the repo:
 * you needed a server URL and a token that live outside it. `eslint-plugin-sonarjs` IS the analyzer
 * SonarQube uses for JS/TS — the same S-numbered rules, the same implementations — so running it
 * here reports the same findings, offline, on every machine and in CI, with no server to own.
 *
 * The Sonar dashboard remains the source of truth for the quality GATE (coverage on new code, the
 * security hotspots review). This is the source of truth for the issues themselves.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    // Mirrors sonar.exclusions in sonar-project.properties. Generated Prisma clients and build
    // output would otherwise dominate the count with code nobody in this repo can fix.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/generated/**",
      "**/*.generated.ts",
      "apps/api/src/generated/**",
      "apps/web/public/**",
      "graphify-out/**",
      ".agents/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/*.d.ts"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
      globals: { ...globals.node, ...globals.browser, ...globals.es2024 }
    },
    rules: {
      /**
       * Rules turned off deliberately, each for a reason that applies to THIS codebase rather than
       * because it was noisy. Anything not listed here is on, and anything it reports is a finding
       * we intend to fix.
       */

      // TypeScript itself reports unused variables through `noUnusedLocals`, which `npm run lint`
      // already runs. Two tools reporting the same thing differently is how one of them gets muted.
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": "off",

      // `any` is used at a handful of deliberate boundaries (Prisma JSON columns, third-party
      // callbacks). Flagging every one produces a long list with no defect in it; the type-aware
      // rules below catch the cases where an `any` actually loses safety.
      "@typescript-eslint/no-explicit-any": "off",

      // Duplicated string literals are usually route paths, permission keys and status values that
      // are clearer repeated than hidden behind a constant. Sonar's own default threshold of 3 is
      // tuned for Java.
      "sonarjs/no-duplicate-string": "off",

      // This codebase writes long, deliberate explanatory comments (see any file header). The rule
      // flags commented-out CODE, but its heuristic cannot reliably tell prose containing a code
      // snippet from dead code, and here that misfires constantly.
      "sonarjs/no-commented-code": "off",

      // Fires on every `todo`/`fixme` in prose, including the ones in comments that EXPLAIN a todo
      // convention. The repo tracks work in docs/ROADMAP.md, not in comment markers.
      "sonarjs/todo-tag": "off",

      // `declare global { namespace Express { ... } }` is the TypeScript-documented way to augment
      // Express's Request type (see middleware/auth.ts, middleware/platform-admin-auth.ts) — there
      // is no ES2015-module spelling for extending an ambient global namespace, so the rule's
      // preferred alternative does not exist here.
      "@typescript-eslint/no-namespace": "off",

      /**
       * STRUCTURAL rules demoted to warnings, not because they are wrong but because of what a
       * gate can honestly hold. `sonar-project.properties` explains the policy this mirrors: gate
       * NEW code, burn existing debt down as files get touched. When this config first ran, these
       * five rules accounted for ~340 findings across ~100k lines that all predate the config —
       * rewriting them retroactively is a huge unreviewable diff with no behavioral benefit, and a
       * permanently-failing lint is one people learn to ignore. Errors (everything above) gate the
       * build at zero; warnings are the visible debt.
       *
       * `slow-regex` is down here for a better reason than volume: every one of its findings was
       * measured with adversarial 20k-char inputs (2026-08), the six real super-linear regexes
       * were fixed, and the rest sat flat at 0ms — the rule cannot see anchoring, so on this
       * codebase its remaining reports are demonstrably false. `void-use` flags the deliberate
       * `void somePromise` fire-and-forget idiom used at ~14 sites.
       */
      "sonarjs/no-nested-conditional": "warn",
      "sonarjs/cognitive-complexity": "warn",
      "sonarjs/no-nested-template-literals": "warn",
      "sonarjs/no-nested-functions": "warn",
      "sonarjs/slow-regex": "warn",
      "sonarjs/regex-complexity": "warn",
      "sonarjs/void-use": "warn"
    }
  },
  {
    /**
     * The Rules of Hooks, for the React app only.
     *
     * Ten `eslint-disable-next-line react-hooks/exhaustive-deps` comments were already scattered
     * through apps/web — written by people who knew the rule and expected it to be running. It was
     * not: no ESLint existed here, so those comments suppressed nothing and every other hook in the
     * app went unchecked. `rules-of-hooks` is an error because breaking it is always a bug;
     * `exhaustive-deps` is a warning because a deliberately-narrow dependency list is sometimes
     * correct, and the existing disable comments say exactly where that was the intent.
     */
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn"
    }
  },
  {
    // Tests legitimately do things production code should not: repeat fixture blocks, assert on
    // magic numbers, nest describes deeply.
    files: ["apps/api/tests/**", "tests/e2e/**", "**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "sonarjs/no-nested-functions": "off",
      "sonarjs/cognitive-complexity": "off",
      "sonarjs/no-hardcoded-passwords": "off",
      "sonarjs/no-hardcoded-ip": "off",
      "sonarjs/pseudo-random": "off"
    }
  },
  {
    // Build scripts and one-shot tooling: console output is the entire point.
    files: ["scripts/**", "**/scripts/**", "*.config.*", "**/*.config.*"],
    rules: { "sonarjs/no-os-command-from-path": "off", "sonarjs/os-command": "off" }
  }
);
