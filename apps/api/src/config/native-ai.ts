/**
 * WHERE THE MANAGED llama.cpp SERVER LIVES — the single place that decides the local model's URL.
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
 * not at all, and `assertNativeBaseUrl` is what proves a stored row still matches.
 *
 * WHY CONSTANTS RATHER THAN ENVIRONMENT VARIABLES, for now. The runtime supervisor — the thing
 * that actually starts `llama-server`, picks its port and knows whether it is up — lands in the
 * next block, and it will own these values. Introducing `NATIVE_AI_PORT` as an operator-facing
 * knob today would mean shipping it through compose, Helm and the install scripts for a process
 * nothing starts yet, then reworking all of it a week later. A named constant with the upstream
 * default is honest about that: it is the value, in one place, ready to be handed over.
 *
 * 127.0.0.1 AND NOT localhost, deliberately. `localhost` resolves through the host's name service
 * and can answer ::1 first, which reaches a different socket than an IPv4-bound `llama-server` and
 * fails as a connection refusal that looks like a dead model. The literal removes the question.
 */

/** llama.cpp's own documented default port for `llama-server`. */
export const NATIVE_AI_PORT = 8080;

/** Loopback only. A native runtime that is reachable from off-box is not the thing this models. */
export const NATIVE_AI_HOST = "127.0.0.1";

/**
 * The base URL a `LLAMA_CPP` provider row is dispatched against. `/v1` because `llama-server`
 * mounts its OpenAI-compatible routes there, which is what lets the exact same client code serve
 * both this and every hosted OpenAI-compatible vendor.
 */
export function nativeProviderBaseUrl(): string {
  return `http://${NATIVE_AI_HOST}:${NATIVE_AI_PORT}/v1`;
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
