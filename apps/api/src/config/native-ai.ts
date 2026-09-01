/**
 * WHERE THE MANAGED llama.cpp SERVER LIVES — the single place that decides the local model's URL,
 * where its weights sit on disk, and which binary would serve them.
 *
 * WHAT: `llama-server` (llama.cpp's own OpenAI-compatible HTTP server) is a process this
 * deployment runs itself, on this host, listening on loopback. A `LLAMA_CPP` provider row points
 * at it, and this file is the ONLY thing allowed to say where "it" is.
 *
 * WHY IT IS A FUNCTION AND NOT A COLUMN. Every other provider kind keeps its endpoint in
 * `AIProviderConfig.baseUrl`, typed by an admin. If the native row did the same, three things go
 * wrong at once: the stored URL rots the moment the runtime moves to another port, an admin can
 * point a "native" row at anything at all (which is precisely the SSRF shape the egress gate
 * exists to stop — see the comment in ai.service.ts#callOpenAICompatible), and there is no longer
 * one answer to "where is the local model" for the supervisor, the health check and the dispatcher
 * to agree on. Deriving it server-side fixes all three: the column is written by this function or
 * not at all, and `isNativeProviderBaseUrl` is what proves a stored row still matches.
 *
 * ── WHAT CHANGED WHEN THE SUPERVISOR ARRIVED ─────────────────────────────────────────────────
 *
 * The first version of this file used named CONSTANTS and said so: the supervisor was not written
 * yet, and shipping `NATIVE_AI_PORT` through compose, Helm and the install scripts for a process
 * nothing started would have meant reworking all of it a week later. The supervisor exists now
 * (services/native-runtime.service.ts), so the constants became `env` reads with the same values as
 * defaults. Every deployment that sets none of them resolves to exactly what the constants said.
 *
 * ADMIN-SUPPLIED AND OPERATOR-SUPPLIED ARE DIFFERENT TRUST LEVELS, and that distinction is what
 * makes `NATIVE_AI_HOST` acceptable when a `baseUrl` column is not. A tenant SUPER_ADMIN is a
 * CUSTOMER in the SaaS deployment; whoever sets an environment variable already owns the process.
 * The egress exemption in `callOpenAICompatible` is unchanged by this: it still asks "is this
 * string exactly what `nativeProviderBaseUrl()` returns right now", which no database row and no
 * request body can influence.
 *
 * 127.0.0.1 AND NOT localhost, deliberately. `localhost` resolves through the host's name service
 * and can answer ::1 first, which reaches a different socket than an IPv4-bound `llama-server` and
 * fails as a connection refusal that looks like a dead model. The literal removes the question.
 * An EMBEDDED runtime is always bound to this address and it is not configurable there — a native
 * runtime reachable from off-box is not the thing this models. The host override exists for
 * `external` mode only, where the sidecar is a different container with its own name.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { env } from "./env.js";
import { storageRoot } from "./storage-paths.js";

/** llama.cpp's own documented default port for `llama-server`. */
export const NATIVE_AI_DEFAULT_PORT = 8080;

/** Loopback. What an embedded runtime is always bound to, and the default for an external one. */
export const NATIVE_AI_LOOPBACK_HOST = "127.0.0.1";

export function nativeAiPort(): number {
  return env.NATIVE_AI_PORT || NATIVE_AI_DEFAULT_PORT;
}

export function nativeAiHost(): string {
  return env.NATIVE_AI_HOST || NATIVE_AI_LOOPBACK_HOST;
}

/**
 * The base URL a `LLAMA_CPP` provider row is dispatched against. `/v1` because `llama-server`
 * mounts its OpenAI-compatible routes there, which is what lets the exact same client code serve
 * both this and every hosted OpenAI-compatible vendor.
 */
export function nativeProviderBaseUrl(): string {
  return `http://${nativeAiHost()}:${nativeAiPort()}/v1`;
}

/**
 * The runtime's own health endpoint, which is NOT under `/v1`.
 *
 * WHY READINESS IS ITS OWN URL AND NOT "did the socket accept": `llama-server` binds and answers
 * immediately, then spends tens of seconds mapping and warming the weights, during which `/health`
 * returns 503. A supervisor that called a successful connect "ready" would mark the provider usable
 * and hand it the first real request, which then fails for a reason that has nothing to do with the
 * request. See services/native-runtime.service.ts#waitForReady.
 */
export function nativeRuntimeHealthUrl(): string {
  return `http://${nativeAiHost()}:${nativeAiPort()}/health`;
}

/**
 * THE MODEL STORE. Where a downloaded GGUF file lives.
 *
 * Defaults to `<storage root>/models`, deliberately INSIDE the tree storage-paths.ts already
 * governs. A deployment that has moved storage onto a real volume (STORAGE_ROOT) gets this on the
 * volume for free, which matters more here than anywhere else in the app: these files are
 * gigabytes each and re-downloading one is not a minor inconvenience.
 *
 * THIS DIRECTORY MUST BE A DOCKER VOLUME, and it is worth being blunt about why. A container's
 * writable layer is discarded when the container is replaced, so a model downloaded into the image
 * layer survives exactly until the next `docker compose up -d` — the operator then watches a
 * five-gigabyte download start again on a deploy that changed one environment variable. The
 * compose/Helm wiring for that lands with the settings screen; this comment exists so that nothing
 * in this file quietly assumes ephemeral storage is acceptable in the meantime.
 *
 * Not a sibling of `avatars`/`face` in storage-paths.ts because it is not user content: it is not
 * per-tenant, it is never served over HTTP, it is not backed up with a workspace's data, and it
 * carries no legal-retention meaning. Everything that file's layout exists to coordinate is
 * irrelevant here, and adding a fourth subtree to `StorageLayout` would put a model file on the
 * admin's uploads diagnostics card next to their attachments.
 */
export function nativeModelDirectory(): string {
  return env.NATIVE_AI_MODEL_DIR || path.join(storageRoot(), "models");
}

/**
 * Which directory the "free disk" figure should describe.
 *
 * The model directory, when it exists — free space is a property of the VOLUME, and an operator who
 * pointed `NATIVE_AI_MODEL_DIR` at a second disk must not be shown the first disk's number. Before
 * the first download that directory does not exist yet and `statfs` would fail, which would report
 * "unknown" on the exact screen an operator visits to decide whether to download anything. Falling
 * back to the storage root is right in that case and never misleading: the default model directory
 * IS a subdirectory of it, so the two are the same volume unless the variable says otherwise.
 *
 * The capability route is read-only and stays read-only — this looks, it does not create.
 */
export function nativeModelDiskPath(): string {
  const directory = nativeModelDirectory();
  return existsSync(directory) ? directory : storageRoot();
}

/**
 * The operator's configured `llama-server` path, or "" for "search PATH".
 *
 * WHERE THE BINARY COMES FROM, AND WHERE IT DOES NOT: nothing in this codebase downloads,
 * bundles or builds one. `config/version.ts` already declines to spawn `git` at boot for the same
 * reason — a runtime dependency on an external binary is a real operational cost, it belongs to
 * whoever runs the box, and making it opt-in is the difference between "AI is unavailable" and "the
 * product will not start".
 */
export function nativeServerBinaryOverride(): string {
  return env.NATIVE_AI_SERVER_BIN.trim();
}

/** What the operator asked for, before the environment probe gets a say. See
 *  services/native-runtime.service.ts#resolveNativeRuntimeMode. */
export function nativeRuntimeModeSetting(): "auto" | "embedded" | "external" | "off" {
  return env.NATIVE_AI_RUNTIME_MODE;
}

/**
 * True when `url` is the derived native endpoint — the check that decides whether the egress gate
 * may be skipped for a row.
 *
 * WHY THE DISPATCHER RE-CHECKS INSTEAD OF TRUSTING `provider === "LLAMA_CPP"`: the enum lives in a
 * database row, and a row can be edited by something other than the write path that derived its
 * URL (a migration, a manual UPDATE, a future bulk import). "Skip the SSRF gate for anything
 * labelled native" would make the label itself the exploit. "Skip it when the URL is the one this
 * file just derived" cannot be, because the answer does not depend on the row at all.
 */
export function isNativeProviderBaseUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && url === nativeProviderBaseUrl();
}
