/// <reference types="vite/client" />

/** The semver baked into this bundle at build time from the repo-root VERSION file — see
 *  vite.config.ts's `define`. Compared against the version the server reports on /api/health to
 *  detect "the server was upgraded underneath this tab". */
declare const __APP_VERSION__: string;
