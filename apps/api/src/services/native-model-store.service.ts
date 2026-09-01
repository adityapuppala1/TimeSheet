/**
 * WHAT: the model store — a directory of GGUF files on this host, and the job that fetches one into
 * it. Everything the settings screen polls while a five-gigabyte download runs, plus the four
 * refusals that stand between "a request returned 200" and "this file is a language model".
 *
 * WHY A JOB ROW AND NOT A PROMISE. There is no SSE and no WebSocket in this codebase, deliberately.
 * The house pattern for long-running work is a database row that a react-query hook polls with a
 * conditional `refetchInterval` — `apps/web/src/pages/settings/AgentRunsCard.tsx` is the precedent,
 * and `NativeModelDownload` is the row. It also survives the restart that an in-memory job loses,
 * which is the failure an operator experiences as "the progress bar disappeared".
 *
 * ── THE FOUR REFUSALS, AND WHY EACH ONE IS HERE AND NOT AT FIRST INFERENCE ───────────────────
 *
 * 1. WHERE IT MAY BE FETCHED FROM. The URL is derived from the catalogue, never typed by anybody,
 *    and is still checked twice: against the catalogue's own host allowlist
 *    (`isNativeDownloadHostAllowed`) and against `utils/egress.ts`'s SSRF gate, on the first request
 *    AND on every redirect hop. Hugging Face answers a large-file request with a 302 to its own CDN,
 *    so redirects cannot be refused outright — which means an unchecked redirect is the hole, and
 *    "the allowlist only covered the first URL" is exactly how one of these becomes decorative.
 *
 * 2. WHETHER THERE IS ROOM. Checked BEFORE a byte moves, and the refusal names both numbers. A disk
 *    that fills at 94% of a model download does not fail cleanly: it takes MySQL's next write with
 *    it, and the operator's incident is "the database went read-only", which nobody connects to the
 *    model they started downloading twenty minutes ago.
 *
 * 3. WHETHER THE FILE IS A GGUF AT ALL. A 404 HTML page, a captive-portal login, an S3 XML error —
 *    every one of them is a 200-shaped response that saves happily under a `.gguf` name. The magic
 *    bytes are four characters at offset zero and they cost one read. Without this check the failure
 *    surfaces as `llama-server` exiting with a parse error minutes later, at which point the
 *    operator is debugging the runtime instead of the download.
 *
 * 4. WHETHER IT IS ALL THERE. `Content-Length` is compared against what actually landed, and the
 *    size is compared against the catalogue's derived estimate. The first catches a stream that
 *    ended early without an error; the second catches a server that lied about the length. Neither
 *    alone is sufficient and neither is expensive.
 *
 * ── WHY A TEMP FILE AND A RENAME ────────────────────────────────────────────────────────────
 *
 * Bytes go to `<name>.gguf.part` and are renamed to `<name>.gguf` only after every check above has
 * passed. A crash, a kill -9 or a power cut therefore leaves a `.part` file — which is resumable and
 * is obviously not a model — rather than a truncated `.gguf` that looks exactly like a complete one.
 * Rename within a directory is atomic on every filesystem this runs on.
 *
 * ── WHAT IS MEASURED, AND WHY IT OUTRANKS THE CATALOGUE ─────────────────────────────────────
 *
 * The catalogue derives a file size from the quantisation's published bits-per-weight and documents
 * that it is derived (see packages/shared/src/native-models.ts). This service records the REAL byte
 * count and a SHA-256 of what actually arrived, and `nativeModelWithMeasuredSize` is how every
 * downstream fit estimate switches to the measured figure the moment one exists. The hash is
 * recorded rather than compared: the catalogue publishes no hashes, and asserting one this project
 * cannot verify would be worse than admitting the gap.
 *
 * WHO CALLS THIS: the `/settings/ai/native/downloads*` routes in controllers/settings.controller.ts,
 * and services/native-runtime.service.ts (which will not start a runtime for a model that is not
 * `ready` here).
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  findNativeModel,
  isNativeDownloadHostAllowed,
  nativeDownloadHostSuffixes,
  nativeDownloadSizeProblem,
  nativeModelDownloadUrl,
  nativeModelStoredFileName,
  nativeModelWeightBytes,
  nativeModelWithMeasuredSize,
  type NativeBenchmarkSummary,
  type NativeModelDownloadRow,
  type NativeModelEntry
} from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { nativeModelDirectory } from "../config/native-ai.js";
import { AppError } from "../middleware/error.js";
import { assertPublicEgressTarget } from "../utils/egress.js";

/* ── the seam ───────────────────────────────────────────────────────────────────────────────── */

/**
 * Everything that touches the network or asks the kernel about the disk, in one injectable object —
 * the same shape and the same reason as `HardwareProbeIo` in hardware-probe.service.ts. The FILE
 * operations are deliberately NOT in here: a test that fakes `rename` proves nothing about the
 * atomic-rename property this file exists to provide, so the tests write real bytes to a real
 * temporary directory and the only things stubbed are the two that would otherwise reach the
 * internet or depend on how full the developer's laptop happens to be.
 */
export interface NativeStoreIo {
  fetch(url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: "manual" }): Promise<Response>;
  /** Bytes available to an unprivileged writer, or null when the platform would not say. */
  freeDiskBytes(directory: string): Promise<number | null>;
  modelDirectory(): string;
  /** The SSRF gate. Injected so a unit test does not resolve `huggingface.co` in DNS. */
  assertEgress(url: string, label: string): Promise<void>;
}

export const defaultNativeStoreIo: NativeStoreIo = {
  fetch: (url, init) => fetch(url, init),
  async freeDiskBytes(directory) {
    try {
      const info = await statfs(directory);
      return Number(info.bavail) * Number(info.bsize);
    } catch {
      return null;
    }
  },
  modelDirectory: nativeModelDirectory,
  assertEgress: async (url, label) => {
    await assertPublicEgressTarget(url, label);
  }
};

/* ── constants that are decisions ───────────────────────────────────────────────────────────── */

/**
 * Free space demanded ON TOP of the file itself.
 *
 * WHY A FLAT GIBIBYTE RATHER THAN A PERCENTAGE: the thing being protected is not the download, it is
 * everything else on the volume — MySQL's next write, the API's log rotation, the OS's temp files.
 * That floor does not scale with the size of the model, so neither does the margin.
 */
export const nativeDownloadDiskMarginBytes = 1024 ** 3;

/** GGUF's four-byte file magic, ASCII, at offset zero. */
const GGUF_MAGIC = Buffer.from("GGUF", "ascii");

/** Enough for Hugging Face's `huggingface.co` -> CDN -> signed-object chain, and no more. An
 *  unbounded redirect loop is a request that never ends and a job row that never finishes. */
const MAX_REDIRECTS = 5;

/** How often progress reaches the database while bytes are moving. A row per chunk would be a write
 *  every few milliseconds for twenty minutes; the UI polls far slower than this anyway. */
const PROGRESS_WRITE_INTERVAL_MS = 2_000;

/* ── in-flight cancellation ─────────────────────────────────────────────────────────────────── */

/**
 * Downloads running in THIS process, so a cancel can actually stop the socket rather than only
 * marking a row.
 *
 * PROCESS-LOCAL AND THAT IS HONEST. A cancel issued to a different instance than the one holding the
 * stream can only mark the row; `runNativeDownload` re-reads the row's status at every progress
 * write and stops when it is no longer running, so the stream still dies — a poll cycle later
 * instead of instantly. Storing the controller in the database is not possible and pretending
 * otherwise would be worse.
 */
const inFlight = new Map<string, AbortController>();

/* ── the pure-ish checks, exported because the tests drive the real ones ─────────────────────── */

/**
 * `null` when `header` starts with GGUF's magic bytes; otherwise the sentence to store on the row.
 *
 * The message quotes what WAS at the start of the file, printable characters only, because the
 * answer is almost always legible and diagnostic: `<!DO` is a 404 page, `<?xm` is an S3 error, `{"e`
 * is a JSON error body. Naming it turns "verification failed" into "you fetched a web page".
 */
export function ggufMagicProblem(header: Buffer): string | null {
  if (header.length >= 4 && header.subarray(0, 4).equals(GGUF_MAGIC)) return null;
  const preview = header
    .subarray(0, 16)
    .toString("latin1")
    .replace(/[^\x20-\x7e]/g, ".");
  return (
    `The downloaded file is not a GGUF model — its first bytes are "${preview}" rather than "GGUF". ` +
    `This is what an error page, a login redirect or a proxy response looks like once it has been saved under a .gguf name.`
  );
}

/** The catalogue entry for an id, or a 422 that says the id is not one this build knows. */
export function requireCatalogueEntry(modelId: string): NativeModelEntry {
  const entry = findNativeModel(modelId);
  if (!entry) {
    throw new AppError(422, `"${modelId}" is not a model in this build's catalogue. Refresh the model list and pick one of the entries it offers.`);
  }
  return entry;
}

/**
 * The URL this entry's file lives at, checked against the catalogue's host allowlist.
 *
 * Throws rather than returning a boolean so a caller cannot forget to look — the same argument
 * `assertPublicEgressTarget` makes for itself one layer down.
 */
export function assertAllowedDownloadUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError(422, `"${url}" is not a valid download URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new AppError(422, `Model downloads must use https:// — "${parsed.protocol}//" was refused.`);
  }
  if (!isNativeDownloadHostAllowed(parsed.hostname)) {
    throw new AppError(
      422,
      `Refusing to download a model from "${parsed.hostname}". The catalogue's models are published on ` +
        `${nativeDownloadHostSuffixes.join(" and ")}, and nothing else is fetched — the download URL is derived from the ` +
        `catalogue entry, so a different host means the entry or a redirect is not what it claims to be.`
    );
  }
  return parsed;
}

/**
 * Refuses to begin when the volume cannot hold the file plus the margin, and SAYS THE NUMBERS.
 *
 * A null free-space reading is permitted to proceed: the platform would not answer, and refusing
 * every download on a filesystem Node cannot `statfs` would break the feature on the machines least
 * able to diagnose it. The download's own write failure is the backstop there.
 */
export async function assertRoomForModel(entry: NativeModelEntry, io: NativeStoreIo = defaultNativeStoreIo): Promise<void> {
  const directory = io.modelDirectory();
  await mkdir(directory, { recursive: true });
  const free = await io.freeDiskBytes(directory);
  if (free === null) return;

  const needed = nativeModelWeightBytes(entry).bytes + nativeDownloadDiskMarginBytes;
  if (free >= needed) return;
  throw new AppError(
    507,
    `Not enough free disk space for ${entry.displayName}. It needs about ${formatGb(needed)} ` +
      `(${formatGb(nativeModelWeightBytes(entry).bytes)} of model plus ${formatGb(nativeDownloadDiskMarginBytes)} kept free for the ` +
      `database and logs), and ${directory} has ${formatGb(free)} available.`
  );
}

function formatGb(bytes: number): string {
  return `${Math.round((bytes / 1024 ** 3) * 100) / 100} GB`;
}

/* ── reading a row back out ─────────────────────────────────────────────────────────────────── */

type DownloadRecord = {
  id: string;
  modelId: string;
  status: string;
  bytesDownloaded: number;
  bytesTotal: number | null;
  fileSizeBytes: number | null;
  sha256: string | null;
  filePath: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  benchmarkedAt: Date | null;
  timeToFirstTokenMs: number | null;
  tokensPerSecond: number | null;
  benchmarkOutputTokens: number | null;
  benchmarkTotalMs: number | null;
  suggestedMaxOutputTokens: number | null;
};

function toBenchmark(row: DownloadRecord): NativeBenchmarkSummary | null {
  if (!row.benchmarkedAt || row.tokensPerSecond === null || row.timeToFirstTokenMs === null) return null;
  return {
    measuredAt: row.benchmarkedAt.toISOString(),
    timeToFirstTokenMs: row.timeToFirstTokenMs,
    tokensPerSecond: row.tokensPerSecond,
    outputTokens: row.benchmarkOutputTokens ?? 0,
    totalMs: row.benchmarkTotalMs ?? 0,
    suggestedMaxOutputTokens: row.suggestedMaxOutputTokens ?? 0,
    basis:
      `Measured on this machine: ${row.tokensPerSecond} tokens/sec after a ${row.timeToFirstTokenMs} ms first token. ` +
      `This replaces the fit estimator's assumed-bandwidth figure, which is a guess by construction.`
  };
}

/** The API shape. `catalogue` is looked up rather than joined — see the column's comment for why a
 *  stored id may name an entry this build no longer ships. */
export function toDownloadRow(row: DownloadRecord): NativeModelDownloadRow {
  const entry = findNativeModel(row.modelId) ?? null;
  return {
    id: row.id,
    modelId: row.modelId,
    status: row.status as NativeModelDownloadRow["status"],
    bytesDownloaded: row.bytesDownloaded,
    bytesTotal: row.bytesTotal,
    fileSizeBytes: row.fileSizeBytes,
    sha256: row.sha256,
    filePath: row.filePath,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    benchmark: toBenchmark(row),
    // The MEASURED size folded in, so anything that estimates a fit from this entry runs on the real
    // number rather than the derivation the moment one has been recorded.
    catalogue: entry ? nativeModelWithMeasuredSize(entry, row.fileSizeBytes) : null
  };
}

/** Every download this workspace has ever started, newest first. Empty is the normal answer and
 *  never an error — the settings screen calls this before anything has been configured. */
export async function listNativeDownloads(): Promise<NativeModelDownloadRow[]> {
  const rows = (await prisma.nativeModelDownload.findMany({ orderBy: { createdAt: "desc" } })) as DownloadRecord[];
  return rows.map(toDownloadRow);
}

export async function getNativeDownload(id: string): Promise<NativeModelDownloadRow> {
  const row = (await prisma.nativeModelDownload.findUnique({ where: { id } })) as DownloadRecord | null;
  if (!row) throw new AppError(404, "That download no longer exists — refresh the list.");
  return toDownloadRow(row);
}

/** The stored model for a catalogue id, if this machine has one that finished. Used by the runtime
 *  supervisor, which will not start a server for a file that never passed verification. */
export async function findReadyModel(modelId: string): Promise<NativeModelDownloadRow | null> {
  const row = (await prisma.nativeModelDownload.findUnique({ where: { modelId } })) as DownloadRecord | null;
  if (!row || row.status !== "ready") return null;
  return toDownloadRow(row);
}

/* ── starting, cancelling, deleting ─────────────────────────────────────────────────────────── */

const IN_FLIGHT_STATUSES = new Set(["queued", "downloading", "verifying"]);

/**
 * Begin fetching a catalogue model, and hand the row straight back so the UI can start polling.
 *
 * The disk check runs BEFORE the row is created, so "there is no room" is a 507 on the button press
 * with both numbers in it, rather than a job that appears in the list and fails a minute later.
 */
export async function startNativeDownload(
  modelId: string,
  actorId: string | null,
  io: NativeStoreIo = defaultNativeStoreIo
): Promise<NativeModelDownloadRow> {
  const entry = requireCatalogueEntry(modelId);

  const existing = (await prisma.nativeModelDownload.findUnique({ where: { modelId } })) as DownloadRecord | null;
  if (existing && IN_FLIGHT_STATUSES.has(existing.status)) return toDownloadRow(existing);
  if (existing && existing.status === "ready") {
    throw new AppError(409, `${entry.displayName} is already downloaded. Delete it first if you want to fetch it again.`);
  }

  await assertRoomForModel(entry, io);

  const data = {
    status: "queued",
    bytesDownloaded: 0,
    bytesTotal: null,
    fileSizeBytes: null,
    sha256: null,
    filePath: null,
    error: null,
    sourceUrl: nativeModelDownloadUrl(entry),
    requestedById: actorId,
    startedAt: null,
    completedAt: null
  };
  const row = (await prisma.nativeModelDownload.upsert({
    where: { modelId },
    update: data,
    create: { modelId, ...data }
  })) as DownloadRecord;

  // Detached exactly like server.ts's optional boot work: the caller gets its row now, and a failure
  // in the transfer becomes a `failed` row with a message rather than an unhandled rejection.
  //
  // IT KEEPS THE REQUEST'S TENANT CONTEXT, which is the non-obvious part and the reason this is safe
  // to detach at all: `tenantContext` is an AsyncLocalStorage, and a promise chain created inside a
  // `run()` stays inside it for its whole life — the HTTP response returning does not end it. So the
  // `prisma` proxy still resolves to the right workspace's client twenty minutes later, and it
  // resolves to the SAME pooled client rather than opening a connection that outlives the request.
  void runNativeDownload(row.id, io).catch((error) => console.warn(`[native-models] download ${row.id} ended abnormally: ${(error as Error).message}`));
  return toDownloadRow(row);
}

/**
 * Stop an in-flight download and remove its partial file.
 *
 * The temp file is removed rather than kept for a later resume, because cancel means "I do not want
 * this", not "pause". A gigabyte of nothing sitting in the model directory until somebody notices is
 * the wrong default for a button labelled Cancel.
 */
export async function cancelNativeDownload(id: string, io: NativeStoreIo = defaultNativeStoreIo): Promise<NativeModelDownloadRow> {
  const row = (await prisma.nativeModelDownload.findUnique({ where: { id } })) as DownloadRecord | null;
  if (!row) throw new AppError(404, "That download no longer exists — refresh the list.");
  if (!IN_FLIGHT_STATUSES.has(row.status)) return toDownloadRow(row);

  // Mark FIRST, then abort. The runner's own abort handler reads the row to decide what to write,
  // and a runner that woke to a still-`downloading` row would helpfully mark it failed.
  const updated = (await prisma.nativeModelDownload.update({
    where: { id },
    data: { status: "cancelled", error: null, completedAt: new Date() }
  })) as DownloadRecord;

  inFlight.get(id)?.abort();
  inFlight.delete(id);
  await removeQuietly(tempPathFor(row.modelId, io));
  return toDownloadRow(updated);
}

/** Remove the stored file and forget the row. Safe when the file is already gone — an operator who
 *  deleted it by hand should be able to clear the row that still claims it. */
export async function deleteNativeModel(id: string, io: NativeStoreIo = defaultNativeStoreIo): Promise<void> {
  const row = (await prisma.nativeModelDownload.findUnique({ where: { id } })) as DownloadRecord | null;
  if (!row) throw new AppError(404, "That model is not in this workspace's store — refresh the list.");
  if (IN_FLIGHT_STATUSES.has(row.status)) {
    throw new AppError(409, "That download is still running. Cancel it first, then delete it.");
  }
  await removeQuietly(row.filePath ?? finalPathFor(row.modelId, io));
  await removeQuietly(tempPathFor(row.modelId, io));
  await prisma.nativeModelDownload.delete({ where: { id } });
}

/* ── the transfer itself ────────────────────────────────────────────────────────────────────── */

/**
 * Where a model's bytes live, resolved through the SEAM rather than through the config module.
 *
 * WHY THROUGH `io`: the model directory is the one piece of state a test genuinely has to relocate —
 * these tests write real gigabyte-shaped files (in miniature) to a real temporary directory, because
 * a test that faked `rename` would prove nothing about the atomic-rename property this file exists
 * to provide. One resolver, used by every path in here, is what keeps the temp file, the final file
 * and the delete from ever disagreeing about where they are.
 */
function finalPathFor(modelId: string, io: NativeStoreIo): string {
  return path.join(io.modelDirectory(), nativeModelStoredFileName(modelId));
}

/** The `.part` suffix is the whole crash-safety story: a partial transfer is never named `.gguf`,
 *  so a half file can never be mistaken for a complete one. */
function tempPathFor(modelId: string, io: NativeStoreIo): string {
  return `${finalPathFor(modelId, io)}.part`;
}

async function removeQuietly(target: string | null): Promise<void> {
  if (!target) return;
  try {
    await rm(target, { force: true });
  } catch {
    // A file we could not delete is a housekeeping problem, never a reason to fail the operation
    // the operator actually asked for.
  }
}

async function sizeOf(target: string): Promise<number> {
  try {
    return (await stat(target)).size;
  } catch {
    return 0;
  }
}

/**
 * Opens the byte stream, following redirects BY HAND.
 *
 * `redirect: "manual"` and an explicit loop, rather than letting `fetch` follow them, is the whole
 * point: an automatic follow would apply the host allowlist and the egress gate to the first URL and
 * to nothing else, and the first URL is the one that was never in doubt. Every hop is re-checked.
 */
async function openStream(
  startUrl: string,
  rangeStart: number,
  signal: AbortSignal,
  io: NativeStoreIo
): Promise<{ response: Response; url: string }> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertAllowedDownloadUrl(url);
    await io.assertEgress(url, "The model download URL");

    const headers: Record<string, string> = { accept: "application/octet-stream" };
    // Resume. A server that ignores this answers 200 with the whole file, which is handled by the
    // caller rather than assumed away — silently appending a full body onto a partial file is how a
    // "resumed" download ends up double its real size and fails verification for the wrong reason.
    if (rangeStart > 0) headers.range = `bytes=${rangeStart}-`;

    const response = await io.fetch(url, { headers, signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new AppError(502, `The download server answered ${response.status} with no destination.`);
      url = new URL(location, url).toString();
      continue;
    }
    return { response, url };
  }
  throw new AppError(502, `The download URL redirected more than ${MAX_REDIRECTS} times; refusing to keep following it.`);
}

/**
 * Hash and inspect the finished temp file in ONE pass.
 *
 * Two things are wanted from a five-gigabyte file — its SHA-256 and its first four bytes — and
 * reading it twice to get them would double the slowest part of verification for no reason.
 */
async function hashAndInspect(target: string): Promise<{ sha256: string; header: Buffer; sizeBytes: number }> {
  const hash = createHash("sha256");
  let header = Buffer.alloc(0);
  let sizeBytes = 0;
  for await (const chunk of createReadStream(target)) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    sizeBytes += buffer.length;
    if (header.length < 16) header = Buffer.concat([header, buffer.subarray(0, 16 - header.length)]);
  }
  return { sha256: hash.digest("hex"), header, sizeBytes };
}

async function failDownload(id: string, message: string): Promise<void> {
  await prisma.nativeModelDownload.update({
    where: { id },
    data: { status: "failed", error: message, completedAt: new Date() }
  });
}

/**
 * THE THREE REFUSALS THAT STAND BETWEEN A FINISHED TRANSFER AND A USABLE MODEL, and the rename that
 * follows when all three pass.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY. Truncation first, because "the download ended early" is the
 * most actionable sentence there is and it is provable from the server's own Content-Length. Then
 * the magic bytes, because an HTML error page fails the size band too and "you fetched a web page"
 * is a far better explanation than "this file is smaller than expected". The derived size band last,
 * as the catch-all for a file that is neither truncated nor obviously wrong.
 *
 * WHAT HAPPENS TO THE PARTIAL FILE IS ALSO A DECISION. Truncation KEEPS it, because it is a real
 * prefix of a real model and the next attempt resumes from it. The other two DELETE it: a file whose
 * first four bytes are not GGUF will never become a model by having more bytes appended, and keeping
 * it would make every subsequent resume append to garbage.
 */
async function verifyAndPromote(input: {
  downloadId: string;
  entry: NativeModelEntry;
  tempPath: string;
  finalPath: string;
  expectedTotal: number | null;
}): Promise<void> {
  const { downloadId, entry, tempPath, finalPath, expectedTotal } = input;
  const { sha256, header, sizeBytes } = await hashAndInspect(tempPath);

  // TRUNCATION. A stream that ends early without an error is the failure that most looks like
  // success — the file is there, the job finished, and the last few hundred megabytes are absent.
  if (expectedTotal !== null && sizeBytes !== expectedTotal) {
    await failDownload(
      downloadId,
      `The download ended early: ${sizeBytes.toLocaleString()} bytes arrived of the ${expectedTotal.toLocaleString()} the server said it would send. ` +
        `The partial file has been kept, so starting the download again will resume it rather than begin from zero.`
    );
    return;
  }

  const problem = ggufMagicProblem(header) ?? nativeDownloadSizeProblem(entry, sizeBytes);
  if (problem) {
    await removeQuietly(tempPath);
    await failDownload(downloadId, problem);
    return;
  }

  // Only now does it get the name of a finished model. Rename within a directory is atomic on every
  // filesystem this runs on, which is what makes a crash impossible to mistake for a success.
  await rename(tempPath, finalPath);
  await prisma.nativeModelDownload.update({
    where: { id: downloadId },
    data: {
      status: "ready",
      bytesDownloaded: sizeBytes,
      // THE MEASURED TRUTH, replacing the catalogue's derived estimate from here on.
      fileSizeBytes: sizeBytes,
      sha256,
      filePath: finalPath,
      error: null,
      completedAt: new Date()
    }
  });
}

/**
 * The job body. Awaitable on purpose — `startNativeDownload` detaches it, and the tests drive it
 * directly, which is what lets "a truncated response does not become ready" be a real assertion
 * about this function rather than about a stub of it.
 */
export async function runNativeDownload(downloadId: string, io: NativeStoreIo = defaultNativeStoreIo): Promise<void> {
  const row = (await prisma.nativeModelDownload.findUnique({ where: { id: downloadId } })) as DownloadRecord | null;
  if (!row || !IN_FLIGHT_STATUSES.has(row.status)) return;

  const entry = findNativeModel(row.modelId);
  if (!entry) {
    await failDownload(downloadId, `"${row.modelId}" is no longer in this build's catalogue, so there is nothing to fetch.`);
    return;
  }

  const tempPath = tempPathFor(row.modelId, io);
  const finalPath = finalPathFor(row.modelId, io);
  const controller = new AbortController();
  inFlight.set(downloadId, controller);

  try {
    await mkdir(path.dirname(tempPath), { recursive: true });
    let resumeFrom = await sizeOf(tempPath);

    const { response } = await openStream(nativeModelDownloadUrl(entry), resumeFrom, controller.signal, io);
    if (!response.ok) {
      throw new AppError(502, `The download server answered ${response.status} ${response.statusText || ""}`.trim() + ".");
    }
    // The server ignored `Range` and is sending the whole file. Start over rather than append: the
    // alternative is a file that is (partial + whole) bytes long and fails verification for a
    // reason that has nothing to do with what went wrong.
    if (resumeFrom > 0 && response.status !== 206) {
      await removeQuietly(tempPath);
      resumeFrom = 0;
    }

    const contentLength = Number(response.headers.get("content-length"));
    const expectedTotal = Number.isFinite(contentLength) && contentLength > 0 ? contentLength + resumeFrom : null;

    await prisma.nativeModelDownload.update({
      where: { id: downloadId },
      data: { status: "downloading", startedAt: new Date(), bytesDownloaded: resumeFrom, bytesTotal: expectedTotal, error: null }
    });

    if (!response.body) throw new AppError(502, "The download server returned no body.");

    let received = resumeFrom;
    let lastWrite = 0;
    let stopped = false;
    // The last progress write, TRACKED rather than abandoned. It is detached from the data handler
    // because a stream must not stall on a database round trip, but it is awaited before
    // verification: a write that landed after the row was marked `ready` would overwrite the final
    // byte count with a mid-transfer one, and the row would then contradict the file beside it.
    let pendingProgress: Promise<unknown> = Promise.resolve();
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on("data", (chunk: Buffer) => {
      received += chunk.length;
      const now = Date.now();
      if (now - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return;
      lastWrite = now;
      const at = received;
      pendingProgress = prisma.nativeModelDownload
        .update({ where: { id: downloadId }, data: { bytesDownloaded: at } })
        .then((updated: { status: string }) => {
          // The row is re-read on every write, and that is what makes a cancel issued to ANOTHER
          // instance work at all: that instance can only mark the row, so this is where the mark
          // turns into a closed socket — a poll interval later rather than instantly.
          if (!stopped && !IN_FLIGHT_STATUSES.has(updated.status)) {
            stopped = true;
            controller.abort();
          }
        })
        .catch(() => {
          // A missed progress write is cosmetic. The transfer is not abandoned over one.
        });
    });

    await pipeline(source, createWriteStream(tempPath, { flags: "a" }));
    await pendingProgress;

    await prisma.nativeModelDownload.update({ where: { id: downloadId }, data: { status: "verifying", bytesDownloaded: received } });
    await verifyAndPromote({ downloadId, entry, tempPath, finalPath, expectedTotal });
  } catch (error) {
    const current = (await prisma.nativeModelDownload.findUnique({ where: { id: downloadId } })) as DownloadRecord | null;
    if (current && IN_FLIGHT_STATUSES.has(current.status)) {
      await failDownload(downloadId, describeTransferFailure(error));
    } else if (current?.status === "cancelled") {
      // A cancel arrives here as an AbortError, and the row already says `cancelled` — writing
      // `failed` over it would turn the operator's own action into an error. The temp file is
      // removed HERE and not only in `cancelNativeDownload` because THIS function owns the open
      // write handle: on Windows a delete against an open file fails outright, so the cancel path's
      // own cleanup can lose the race and silently leave a gigabyte behind.
      await removeQuietly(tempPath);
    }
  } finally {
    inFlight.delete(downloadId);
  }
}

/** The partial file is kept for every failure that reaches here, because every failure that reaches
 *  here is a transport one and therefore resumable. The verification failures above delete it
 *  themselves, since a file that is not a GGUF will never become one by being resumed. */
function describeTransferFailure(error: unknown): string {
  if (error instanceof AppError) return error.message;
  const message = (error as Error)?.message ?? String(error);
  return `The transfer failed: ${message}. The partial file has been kept, so starting the download again resumes it.`;
}

/* ── the benchmark's write path ─────────────────────────────────────────────────────────────── */

/** Records a measurement against the stored model. Separate from the benchmark service itself so
 *  that service owns the HTTP call and this file stays the only writer of this table. */
export async function recordNativeBenchmark(
  modelId: string,
  measurement: {
    timeToFirstTokenMs: number;
    tokensPerSecond: number;
    outputTokens: number;
    totalMs: number;
    suggestedMaxOutputTokens: number;
  }
): Promise<NativeModelDownloadRow> {
  const row = (await prisma.nativeModelDownload.update({
    where: { modelId },
    data: {
      benchmarkedAt: new Date(),
      timeToFirstTokenMs: Math.round(measurement.timeToFirstTokenMs),
      tokensPerSecond: measurement.tokensPerSecond,
      benchmarkOutputTokens: measurement.outputTokens,
      benchmarkTotalMs: Math.round(measurement.totalMs),
      suggestedMaxOutputTokens: measurement.suggestedMaxOutputTokens
    }
  })) as DownloadRecord;
  return toDownloadRow(row);
}
