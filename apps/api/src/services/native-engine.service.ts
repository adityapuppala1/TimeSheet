/**
 * WHAT: how `llama-server` gets onto this host. Resolves the one published build that can run here,
 * fetches it from a constrained host, proves the archive is an archive, extracts only the entries it
 * asked for while refusing any that name a path outside the destination, marks the result
 * executable, RUNS it, and only then calls it installed.
 *
 * ── WHY THIS EXISTS, AND WHY ITS ABSENCE WAS THE REAL BUG ───────────────────────────────────
 *
 * The rest of this block worked. A 940 MB model downloaded, verified, hashed and sat on disk — and
 * the panel then ended at "install llama.cpp on this host and point NATIVE_AI_SERVER_BIN at the
 * binary". For a product whose promise is "pick a model, download it, run it", that sentence is not
 * an instruction, it is a wall with an instruction painted on it. Everything else in the native
 * block was unusable behind it.
 *
 * ── WHAT IS NOT DONE HERE, AND THAT IS THE POINT ────────────────────────────────────────────
 *
 * NOTHING IS FETCHED AT BOOT. `startNativeRuntimeIfConfigured` does not call into this file and must
 * never be made to: downloading a binary from the internet and then EXECUTING it is a decision an
 * operator makes knowingly, with the release, the host, the asset name and the size in front of
 * them. That is why {@link describeNativeEngine} exists as a read-only report — the settings screen
 * renders the whole plan BEFORE the button is enabled — and why the install route is a POST behind
 * `requireSuperAdmin`.
 *
 * ── WHAT IS REUSED RATHER THAN REWRITTEN ────────────────────────────────────────────────────
 *
 * The transfer is native-model-store.service.ts's, exported for this: `openAllowlistedStream`
 * follows redirects BY HAND and re-applies the host allowlist and the SSRF gate to every hop, and
 * `hashAndInspect` reads the finished file once for its size, its hash and its magic bytes. Writing
 * a second downloader would have given "the allowlist only covered the first URL" a second place to
 * live, and that is the bug the model store's header spends a paragraph on. What is NOT shared is the
 * job row: an install has a release tag, a zip, an extraction and a version probe where a model
 * download has a catalogue id, GGUF magic and a size band, so a shared table would be half NULLs and
 * a `status` column meaning two different things.
 *
 * ── THE FIVE REFUSALS, AND WHY EACH IS HERE RATHER THAN AT FIRST INFERENCE ──────────────────
 *
 * 1. MUSL. Checked before anything is offered. llama.cpp publishes only glibc-linked Linux builds and
 *    this app's image is `node:22-alpine`. A glibc binary on musl fails with the kernel loader's
 *    "no such file or directory" — naming a file that plainly exists — which is one of the most
 *    misleading errors in Linux. So Alpine is told plainly to run a sidecar, and offered no download.
 *
 * 2. THE HOST. The URL is DERIVED from a pinned tag and a platform table, never typed by anybody, and
 *    is still checked on the first request AND on every redirect hop. GitHub answers a release-asset
 *    request with a 302 to `objects.githubusercontent.com`, so redirects cannot be refused outright.
 *
 * 3. IS IT AN ARCHIVE AT ALL. Four magic bytes at offset zero. A captive portal, a 404 page and an
 *    S3 XML error are all 200-shaped responses that save happily under a `.zip` name, and without
 *    this the failure surfaces as an unintelligible extraction error.
 *
 * 4. PATH TRAVERSAL. Extracting an archive from the internet is exactly where this bites. Every entry
 *    name is checked and ONE bad entry fails the whole install — see the note on `extractEngineZip`
 *    for why refusing beats sanitising even though the layout also flattens.
 *
 * 5. DOES IT ACTUALLY RUN. The last and the one most often skipped. A wrong-architecture binary, a
 *    partial extraction, a missing shared library and an ABI mismatch all extract perfectly and fail
 *    at the first inference — minutes later, to somebody who has been told the install succeeded.
 *    So the binary is spawned with `--version`, and its answer is stored as the evidence.
 *
 * ── WHY THE ZIP READER IS IN THIS FILE ──────────────────────────────────────────────────────
 *
 * `node:zlib` provides `inflateRaw`, which is the only hard part of a zip. The alternative was a new
 * runtime dependency for one button, in the one place in this codebase where the supply chain is the
 * actual subject. Sixty lines of central-directory parsing, refusing everything it does not
 * understand, is a better trade — and it is what lets the traversal refusal be a property of code
 * this repository owns and tests rather than of a library's options object.
 *
 * WHO CALLS THIS: the `/settings/ai/native/engine*` routes in controllers/settings.controller.ts, and
 * native-runtime.service.ts#resolveServerBinary, which looks in the directory this file writes to.
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import {
  isNativeEngineHostAllowed,
  nativeEngineBinaryFileName,
  nativeEngineEntryProblem,
  nativeEngineHostSuffixes,
  nativeEngineInstallInFlightStatuses,
  nativeEngineSidecarInstructions,
  nativeEngineWantedEntry,
  resolveNativeEngineAsset,
  zipMagicProblem,
  type NativeEngineAsset,
  type NativeEngineInstallRow,
  type NativeEngineReport,
  type NativeEngineResolution,
  type NativeLibc
} from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { nativeEngineDirectory, nativeEngineReleaseTag, nativeEngineRoot } from "../config/native-ai.js";
import { AppError } from "../middleware/error.js";
import { assertPublicEgressTarget } from "../utils/egress.js";
import { detectLibcFlavour } from "./hardware-probe.service.js";
import { PROGRESS_WRITE_INTERVAL_MS, assertAllowedFetchUrl, hashAndInspect, openAllowlistedStream } from "./native-model-store.service.js";

const inflateRawAsync = promisify(inflateRaw);

/* ── the seam ───────────────────────────────────────────────────────────────────────────────── */

/**
 * Everything that touches the network, the loader or a child process — the same shape and the same
 * reason as `NativeStoreIo` and `HardwareProbeIo`. The FILE operations are deliberately not in here:
 * a test that faked `rename` or `chmod` would prove nothing about the atomic-rename and
 * executable-bit properties this file exists to provide, so the tests extract real archives into a
 * real temporary directory and only the three things that would otherwise reach the internet, the
 * host's libc or a real llama.cpp binary are stubbed.
 */
export interface NativeEngineIo {
  fetch(url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: "manual" }): Promise<Response>;
  assertEgress(url: string, label: string): Promise<void>;
  platform(): NodeJS.Platform;
  arch(): string;
  /** `null` when this is not a Linux question, or a Linux we could not read. Never guessed. */
  libc(): Promise<NativeLibc | null>;
  /** Where a given release's files live on this host. */
  engineDirectory(releaseTag: string): string;
  /** The parent of every installed release. */
  engineRoot(): string;
  releaseTag(): string;
  /** Runs the freshly-extracted binary and returns what it said, or the reason it said nothing. This
   *  is the step that turns "the archive extracted" into "this host has a working llama-server". */
  probeBinary(binaryPath: string): Promise<{ ok: true; output: string } | { ok: false; message: string }>;
}

export const defaultNativeEngineIo: NativeEngineIo = {
  fetch: (url, init) => fetch(url, init),
  assertEgress: async (url, label) => {
    await assertPublicEgressTarget(url, label);
  },
  platform: () => process.platform,
  arch: () => process.arch,
  libc: () => detectLibcFlavour(),
  engineDirectory: nativeEngineDirectory,
  engineRoot: nativeEngineRoot,
  releaseTag: nativeEngineReleaseTag,
  probeBinary: (binaryPath) => runVersionProbe(binaryPath)
};

/* ── constants that are decisions ───────────────────────────────────────────────────────────── */

/**
 * The largest archive this will read into memory to extract.
 *
 * A CEILING AND NOT A GUESS AT THE REAL SIZE. Zip extraction needs random access to the central
 * directory at the END of the file and to local headers scattered through it, so the archive is read
 * whole rather than streamed — which is fine at 26 MB and is a denial of service at 26 GB. The real
 * assets are tens of megabytes; 512 MB is far above any of them and far below anything that would
 * hurt this process.
 */
export const nativeEngineMaxArchiveBytes = 512 * 1024 * 1024;

/** How long the extracted binary gets to answer `--version` before the probe gives up. Generous
 *  enough for a cold page cache on a slow disk, short enough that a binary which hangs on startup
 *  fails the install rather than hanging the request. */
export const nativeEngineProbeTimeoutMs = 20_000;

/** The statuses an install is still moving through. */
const IN_FLIGHT = new Set<string>(nativeEngineInstallInFlightStatuses);

/**
 * Installs running in THIS process, so a cancel can close the socket rather than only marking a row.
 * Process-local and honest about it, exactly like the model store's: a cancel issued to another
 * instance can only mark the row, and the runner re-reads that row at every progress write.
 */
const inFlight = new Map<string, AbortController>();

/* ── the plan, which is rendered BEFORE the click ───────────────────────────────────────────── */

/** The engine URL gate — the model store's general host check with GitHub's allowlist bound in. */
export function assertAllowedEngineUrl(url: string): URL {
  return assertAllowedFetchUrl({
    url,
    isHostAllowed: isNativeEngineHostAllowed,
    what: "the llama.cpp engine",
    allowedHosts: nativeEngineHostSuffixes
  });
}

/**
 * WHAT WOULD BE FETCHED HERE, or the reason nothing can be — computed without touching the network.
 *
 * Read-only and safe to call at any time in any mode, because the settings screen polls it on first
 * paint before an operator has done anything. "Nothing can be installed here" is an ANSWER, never an
 * error, and it always arrives with the sidecar instructions attached.
 */
export async function describeNativeEngine(
  runtimeMode: "embedded" | "external" | "off",
  binary: { path: string | null; source: NativeEngineReport["binarySource"]; problem: string | null },
  io: NativeEngineIo = defaultNativeEngineIo
): Promise<NativeEngineReport> {
  const platform = io.platform();
  const arch = io.arch();
  const libc = await io.libc();
  const resolution = resolveNativeEngineAsset({ platform, arch, libc, releaseTag: io.releaseTag() });
  const install = await latestInstall();

  return {
    binaryPath: binary.path,
    binarySource: binary.source,
    problem: binary.problem,
    // ONLY `embedded` CAN USE ONE. In `external` mode a sidecar owns the process and a binary on this
    // host would sit unused; in `off` mode there is no runtime at all. Installing anyway would be
    // spending an operator's bandwidth on a file nothing will ever spawn.
    installable: runtimeMode === "embedded" && resolution.ok,
    resolution,
    platform,
    arch,
    libc,
    install,
    sidecarInstructions: nativeEngineSidecarInstructions
  };
}

/* ── reading rows back out ──────────────────────────────────────────────────────────────────── */

type InstallRecord = {
  id: string;
  status: string;
  releaseTag: string;
  assetName: string;
  sourceUrl: string;
  bytesDownloaded: number;
  bytesTotal: number | null;
  fileSizeBytes: number | null;
  sha256: string | null;
  binaryPath: string | null;
  versionOutput: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toEngineInstallRow(row: InstallRecord): NativeEngineInstallRow {
  return {
    id: row.id,
    status: row.status as NativeEngineInstallRow["status"],
    releaseTag: row.releaseTag,
    assetName: row.assetName,
    sourceUrl: row.sourceUrl,
    bytesDownloaded: row.bytesDownloaded,
    bytesTotal: row.bytesTotal,
    fileSizeBytes: row.fileSizeBytes,
    sha256: row.sha256,
    binaryPath: row.binaryPath,
    versionOutput: row.versionOutput,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

/** The most recent attempt, or null. Null is the ordinary first answer and never an error — a
 *  deployment that has never opened this screen has no rows. */
export async function latestInstall(): Promise<NativeEngineInstallRow | null> {
  try {
    const row = (await prisma.nativeEngineInstall.findFirst({ orderBy: { createdAt: "desc" } })) as InstallRecord | null;
    return row ? toEngineInstallRow(row) : null;
  } catch {
    // A table that is not there yet (a deployment mid-migration) must not 500 the settings screen.
    // "No install has been attempted" is the truthful rendering of that state.
    return null;
  }
}

/* ── finding what is already installed ──────────────────────────────────────────────────────── */

/**
 * The managed `llama-server` on this host, if a previous install left one.
 *
 * SYNCHRONOUS-FRIENDLY AND NEVER THROWS, because `resolveServerBinary` is called from the boot path
 * and from a status endpoint, neither of which may fail over a directory that is not there. It
 * prefers the release this build currently pins and falls back to any other installed release, which
 * is what stops a pin bump from making a working box report "no binary" until somebody reinstalls.
 */
export function findManagedEngineBinary(
  fileExists: (target: string) => boolean,
  listDirectories: (target: string) => string[],
  platform: NodeJS.Platform,
  releaseTag: string,
  root: string,
  directoryFor: (tag: string) => string
): string | null {
  const fileName = nativeEngineBinaryFileName(platform);
  const pinned = path.join(directoryFor(releaseTag), fileName);
  if (fileExists(pinned)) return pinned;

  // Any other release that was installed here. Sorted descending so the newest build number wins —
  // the tags are `b<number>` and a lexical sort over equal-length numbers is the same order.
  for (const tag of listDirectories(root).sort().reverse()) {
    if (tag === releaseTag) continue;
    const candidate = path.join(directoryFor(tag), fileName);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

/* ── starting and cancelling ────────────────────────────────────────────────────────────────── */

/**
 * Begin installing the engine, and hand the row straight back so the UI can poll.
 *
 * EVERY REFUSAL HAPPENS BEFORE THE ROW EXISTS, so "this host cannot run a published build" is an
 * answer on the button press with the reason in it, rather than a job that appears in the list and
 * fails a minute later. That ordering is the same one `startNativeDownload` uses for the disk check
 * and for the same reason.
 */
export async function startNativeEngineInstall(
  runtimeMode: "embedded" | "external" | "off",
  actorId: string | null,
  io: NativeEngineIo = defaultNativeEngineIo
): Promise<NativeEngineInstallRow> {
  if (runtimeMode !== "embedded") {
    throw new AppError(
      409,
      `The runtime mode here is "${runtimeMode}", so this process does not spawn llama-server and a binary on this host would sit ` +
        `unused. ${runtimeMode === "off" ? "Set NATIVE_AI_RUNTIME_MODE to embedded to run one here." : nativeEngineSidecarInstructions}`
    );
  }

  const resolution: NativeEngineResolution = resolveNativeEngineAsset({
    platform: io.platform(),
    arch: io.arch(),
    libc: await io.libc(),
    releaseTag: io.releaseTag()
  });
  // THE MUSL / UNSUPPORTED-PLATFORM REFUSAL, as a 422 with the sidecar instructions in it. A 422
  // rather than a 500 because nothing failed: this host genuinely has no published build, and that
  // is a fact about the host, not an error in the request.
  if (!resolution.ok) throw new AppError(422, resolution.message);

  const existing = (await prisma.nativeEngineInstall.findFirst({ orderBy: { createdAt: "desc" } })) as InstallRecord | null;
  if (existing && IN_FLIGHT.has(existing.status)) return toEngineInstallRow(existing);

  const asset = resolution.asset;
  const row = (await prisma.nativeEngineInstall.create({
    data: {
      status: "queued",
      releaseTag: asset.releaseTag,
      assetName: asset.assetName,
      sourceUrl: asset.url,
      bytesDownloaded: 0,
      bytesTotal: null,
      fileSizeBytes: null,
      sha256: null,
      binaryPath: null,
      versionOutput: null,
      error: null,
      requestedById: actorId,
      startedAt: null,
      completedAt: null
    }
  })) as InstallRecord;

  // Detached with the request's tenant context intact — the same argument `startNativeDownload`
  // makes: `tenantContext` is an AsyncLocalStorage and a promise chain created inside a `run()`
  // stays inside it for its whole life, so `prisma` still resolves to the right workspace's pooled
  // client after the HTTP response has gone.
  void runNativeEngineInstall(row.id, asset, io).catch((error) =>
    console.warn(`[native-engine] install ${row.id} ended abnormally: ${(error as Error).message}`)
  );
  return toEngineInstallRow(row);
}

/** Stop an in-flight install and remove its partial archive. Cancel means "I do not want this". */
export async function cancelNativeEngineInstall(id: string, io: NativeEngineIo = defaultNativeEngineIo): Promise<NativeEngineInstallRow> {
  const row = (await prisma.nativeEngineInstall.findUnique({ where: { id } })) as InstallRecord | null;
  if (!row) throw new AppError(404, "That install no longer exists — refresh the panel.");
  if (!IN_FLIGHT.has(row.status)) return toEngineInstallRow(row);

  // Mark FIRST, then abort — the runner reads the row to decide what to write, and a runner that
  // woke to a still-`downloading` row would helpfully mark it failed over the operator's own action.
  const updated = (await prisma.nativeEngineInstall.update({
    where: { id },
    data: { status: "cancelled", error: null, completedAt: new Date() }
  })) as InstallRecord;

  inFlight.get(id)?.abort();
  inFlight.delete(id);
  await removeQuietly(archivePathFor(row.releaseTag, io));
  return toEngineInstallRow(updated);
}

/* ── the transfer, the extraction and the proof ─────────────────────────────────────────────── */

/** The `.part` suffix carries the whole crash-safety story here as it does in the model store: a
 *  partial transfer is never named `.zip`, so a half archive cannot be mistaken for a complete one. */
function archivePathFor(releaseTag: string, io: NativeEngineIo): string {
  return path.join(io.engineDirectory(releaseTag), `engine-${releaseTag}.zip.part`);
}

async function removeQuietly(target: string | null): Promise<void> {
  if (!target) return;
  try {
    await rm(target, { force: true, recursive: true });
  } catch {
    // A file we could not delete is a housekeeping problem, never a reason to fail the operation the
    // operator actually asked for.
  }
}

async function failInstall(id: string, message: string): Promise<void> {
  await prisma.nativeEngineInstall.update({
    where: { id },
    data: { status: "failed", error: message, completedAt: new Date() }
  });
}

/**
 * The job body. Awaitable on purpose — `startNativeEngineInstall` detaches it and the tests drive it
 * directly, which is what lets "a `../` entry does not become an installed engine" be a real
 * assertion about this function rather than about a stub of it.
 */
export async function runNativeEngineInstall(
  installId: string,
  asset: NativeEngineAsset,
  io: NativeEngineIo = defaultNativeEngineIo
): Promise<void> {
  const row = (await prisma.nativeEngineInstall.findUnique({ where: { id: installId } })) as InstallRecord | null;
  if (!row || !IN_FLIGHT.has(row.status)) return;

  const destination = io.engineDirectory(asset.releaseTag);
  const archivePath = archivePathFor(asset.releaseTag, io);
  const controller = new AbortController();
  inFlight.set(installId, controller);

  try {
    await mkdir(destination, { recursive: true });
    await removeQuietly(archivePath);

    const { response } = await openAllowlistedStream({
      startUrl: asset.url,
      rangeStart: 0,
      signal: controller.signal,
      fetch: io.fetch,
      assertEgress: io.assertEgress,
      // EVERY HOP, not just the first. GitHub 302s a release asset to its object storage, so a check
      // that only covered the initial URL would be checking the one thing never in doubt.
      assertAllowedUrl: (url) => void assertAllowedEngineUrl(url),
      egressLabel: "The llama.cpp engine download URL"
    });
    if (!response.ok) {
      throw new AppError(
        502,
        `The release server answered ${response.status} ${response.statusText || ""}`.trim() +
          ` for ${asset.assetName}. This build pins release ${asset.releaseTag}; if that release does not publish this asset, ` +
          `set NATIVE_AI_ENGINE_RELEASE to one that does.`
      );
    }

    const contentLength = Number(response.headers.get("content-length"));
    const expectedTotal = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
    if (expectedTotal !== null && expectedTotal > nativeEngineMaxArchiveBytes) {
      throw new AppError(
        502,
        `The engine archive claims to be ${Math.round(expectedTotal / 1024 / 1024)} MB, which is far larger than any llama.cpp ` +
          `release asset. Refusing to download it.`
      );
    }

    // CONDITIONAL, for the reason spelled out on the same write in native-model-store.service.ts: a
    // Cancel pressed while the socket was opening has already written `cancelled`, and an
    // unconditional update here would put the row back in flight and then record the operator's own
    // abort as a failure. The status guard lives in the WHERE clause so the check and the write are
    // one statement with no window between them.
    const advanced = await prisma.nativeEngineInstall.updateMany({
      where: { id: installId, status: { in: [...nativeEngineInstallInFlightStatuses] } },
      data: { status: "downloading", startedAt: new Date(), bytesDownloaded: 0, bytesTotal: expectedTotal, error: null }
    });
    if (advanced.count === 0) {
      controller.abort();
      await removeQuietly(archivePath);
      return;
    }

    if (!response.body) throw new AppError(502, "The release server returned no body.");
    await streamToFile(response, archivePath, installId, controller);

    await prisma.nativeEngineInstall.update({ where: { id: installId }, data: { status: "verifying" } });
    const { sha256, header, sizeBytes } = await hashAndInspect(archivePath);

    // REFUSAL 3: is it an archive at all. An error page, a captive portal and an S3 XML error are all
    // 200-shaped responses that save happily under a `.zip` name.
    const magicProblem = zipMagicProblem(new Uint8Array(header));
    if (magicProblem) {
      await removeQuietly(archivePath);
      await failInstall(installId, magicProblem);
      return;
    }
    if (sizeBytes > nativeEngineMaxArchiveBytes) {
      await removeQuietly(archivePath);
      await failInstall(installId, `The engine archive is ${Math.round(sizeBytes / 1024 / 1024)} MB, which is too large to be a llama.cpp release asset.`);
      return;
    }

    await prisma.nativeEngineInstall.update({
      where: { id: installId },
      data: { status: "installing", fileSizeBytes: sizeBytes, sha256, bytesDownloaded: sizeBytes }
    });

    // REFUSAL 4 lives inside here: one traversal entry fails the whole install.
    const extracted = await extractEngineZip(archivePath, destination, io.platform());
    await removeQuietly(archivePath);

    const binaryPath = path.join(destination, nativeEngineBinaryFileName(io.platform()));
    if (!extracted.includes(binaryPath)) {
      await failInstall(
        installId,
        `${asset.assetName} extracted, but it contains no ${nativeEngineBinaryFileName(io.platform())}. That asset is not a ` +
          `llama.cpp server build, or its layout changed. Nothing was installed.`
      );
      return;
    }

    // THE EXECUTABLE BIT, on POSIX. A zip's stored mode is not portable and Node's extractor here
    // writes 0644, so a perfectly extracted binary would fail to spawn with EACCES — an error that
    // reads like a permissions problem with the directory rather than with the file.
    if (io.platform() !== "win32") {
      for (const file of extracted) await chmod(file, 0o755);
    }

    // REFUSAL 5: does it actually run. The step most often skipped, and the one that separates "the
    // archive extracted" from "this host has a working llama-server".
    const probe = await io.probeBinary(binaryPath);
    if (!probe.ok) {
      // The extracted tree is REMOVED, not kept. A directory holding a binary that does not run is a
      // directory `resolveServerBinary` would find and hand to `spawn` on the next start, turning a
      // failed install into a runtime that fails mysteriously for as long as it sits there.
      await removeQuietly(destination);
      await failInstall(
        installId,
        `${asset.assetName} downloaded and extracted, but the binary did not answer when it was run: ${probe.message} ` +
          `Nothing was installed. ${nativeEngineSidecarInstructions}`
      );
      return;
    }

    await prisma.nativeEngineInstall.update({
      where: { id: installId },
      data: {
        status: "ready",
        binaryPath,
        versionOutput: probe.output.slice(0, 480),
        error: null,
        completedAt: new Date()
      }
    });
  } catch (error) {
    const current = (await prisma.nativeEngineInstall.findUnique({ where: { id: installId } })) as InstallRecord | null;
    if (current && IN_FLIGHT.has(current.status)) {
      await removeQuietly(archivePath);
      await failInstall(installId, describeInstallFailure(error));
    } else if (current?.status === "cancelled") {
      // A cancel arrives as an AbortError and the row already says `cancelled`. The archive is removed
      // HERE and not only in the cancel path because THIS function owns the open write handle: on
      // Windows a delete against an open file fails outright, so the cancel's own cleanup can lose
      // the race and silently leave the file behind.
      await removeQuietly(archivePath);
    }
  } finally {
    inFlight.delete(installId);
  }
}

/** Nothing is resumable here — an engine archive is tens of megabytes, so restarting the transfer is
 *  cheaper than reasoning about a partial one, and the partial file is always removed. */
function describeInstallFailure(error: unknown): string {
  if (error instanceof AppError) return error.message;
  const message = (error as Error)?.message ?? String(error);
  return `The engine download failed: ${message}. Nothing was installed; press Install again to retry.`;
}

/**
 * Bytes onto disk, with the row updated on a cadence rather than per chunk, and the row re-read on
 * every write so a cancel issued to another instance still closes this socket. The same shape as the
 * model store's transfer loop, at a smaller scale.
 */
async function streamToFile(response: Response, target: string, installId: string, controller: AbortController): Promise<void> {
  let received = 0;
  let lastWrite = 0;
  let stopped = false;
  let pendingProgress: Promise<unknown> = Promise.resolve();
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on("data", (chunk: Buffer) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return;
    lastWrite = now;
    const at = received;
    pendingProgress = prisma.nativeEngineInstall
      .update({ where: { id: installId }, data: { bytesDownloaded: at } })
      .then((updated: { status: string }) => {
        if (!stopped && !IN_FLIGHT.has(updated.status)) {
          stopped = true;
          controller.abort();
        }
      })
      .catch(() => {
        // A missed progress write is cosmetic. The transfer is not abandoned over one.
      });
  });
  await pipeline(source, createWriteStream(target));
  // AWAITED, not abandoned: a write that landed after the row was marked `installing` would
  // overwrite the byte count with a mid-transfer one and the row would contradict the file beside it.
  await pendingProgress;
}

/* ── the zip reader ─────────────────────────────────────────────────────────────────────────── */

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The sentinel a zip writes into a 32-bit field when the real value needs zip64. Seeing one means
 *  this reader would silently misparse, so it refuses instead. No llama.cpp asset is anywhere near
 *  the sizes that require it. */
const ZIP64_SENTINEL = 0xffffffff;

/**
 * Parses the central directory. Refuses everything it does not fully understand rather than guessing.
 *
 * READ WHOLE RATHER THAN STREAMED, deliberately: a zip's directory is at the END and its entries
 * point BACKWARDS into the file, so a streaming reader would either buffer it all anyway or trust the
 * local headers — and the local headers are exactly the ones an attacker controls without the
 * directory agreeing. {@link nativeEngineMaxArchiveBytes} is what keeps "read whole" bounded.
 */
export function readZipEntries(archive: Buffer): ZipEntry[] {
  // The EOCD is at the end, after an optional comment of up to 64 KiB, so it is searched backwards.
  const searchFrom = Math.max(0, archive.length - 66 * 1024);
  let eocd = -1;
  for (let at = archive.length - 22; at >= searchFrom; at -= 1) {
    if (archive.readUInt32LE(at) === EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new AppError(422, "The engine archive has no zip end-of-directory record — it is truncated or is not a zip file.");

  const entryCount = archive.readUInt16LE(eocd + 10);
  const directoryOffset = archive.readUInt32LE(eocd + 16);
  if (directoryOffset === ZIP64_SENTINEL || archive.readUInt32LE(eocd + 12) === ZIP64_SENTINEL) {
    throw new AppError(422, "The engine archive uses the zip64 format, which this installer does not read. No llama.cpp release asset needs it.");
  }

  const entries: ZipEntry[] = [];
  let at = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (at + 46 > archive.length || archive.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new AppError(422, "The engine archive's directory is malformed — refusing to extract it.");
    }
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    entries.push({
      name: archive.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
      compressionMethod: archive.readUInt16LE(at + 10),
      compressedSize: archive.readUInt32LE(at + 20),
      uncompressedSize: archive.readUInt32LE(at + 24),
      localHeaderOffset: archive.readUInt32LE(at + 42)
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * EXTRACTS ONLY WHAT WAS ASKED FOR, INTO A FLAT DIRECTORY, AND REFUSES ANY ENTRY THAT NAMES A PATH
 * OUTSIDE IT.
 *
 * WHY REFUSING BEATS SANITISING even though the destination name is the entry's BASENAME (which
 * would already neutralise `../`): a defence that only holds because of an unrelated decision one
 * layer away is a defence that disappears the day somebody preserves directory structure. And an
 * archive containing `..` is not a release with an awkward filename in it — it is an archive doing
 * something no legitimate build does, so the whole install stops rather than quietly extracting the
 * other nine files.
 *
 * WHY A FINAL `path.resolve` CHECK AS WELL, when the name has already been reduced to a basename:
 * belt and braces on the one operation where the cost of being wrong is a file written somewhere
 * this process was never meant to write. It costs a string comparison per entry.
 *
 * Every file lands under a `.part` name and is renamed into place only once its bytes are complete,
 * so a crash mid-extraction cannot leave a half-written `llama-server` that looks installed.
 */
export async function extractEngineZip(archivePath: string, destination: string, platform: NodeJS.Platform): Promise<string[]> {
  const size = (await stat(archivePath)).size;
  if (size > nativeEngineMaxArchiveBytes) {
    throw new AppError(422, `The engine archive is ${Math.round(size / 1024 / 1024)} MB, which is too large to be a llama.cpp release asset.`);
  }
  const archive = await readFile(archivePath);
  const entries = readZipEntries(archive);
  // Created HERE as well as by the caller, so this function is complete on its own: it is the piece
  // the tests drive directly, and an extractor that only works when somebody else made the directory
  // first is an extractor whose guarantees are somebody else's.
  await mkdir(destination, { recursive: true });

  // THE TRAVERSAL PASS RUNS FIRST, OVER EVERY ENTRY, BEFORE A SINGLE BYTE IS WRITTEN. Checking as we
  // go would leave whatever was extracted before the bad entry sitting on disk, which is the half
  // state this refusal exists to prevent.
  for (const entry of entries) {
    const problem = nativeEngineEntryProblem(entry.name);
    if (problem) throw new AppError(422, problem);
  }

  const written: string[] = [];
  for (const entry of entries) {
    const wanted = nativeEngineWantedEntry(entry.name, platform);
    if (!wanted.keep) continue;

    const target = path.resolve(destination, wanted.destName);
    // The resolved path must still be a direct child of the destination. See the header.
    if (path.dirname(target) !== path.resolve(destination)) {
      throw new AppError(422, `Refusing to extract "${entry.name}" — it resolves outside the engine directory.`);
    }

    const body = await inflateEntry(archive, entry);
    const temporary = `${target}.part`;
    await writeFile(temporary, body);
    await rename(temporary, target);
    written.push(target);
  }
  return written;
}

/** Store and deflate, and nothing else. A compression method this does not implement is refused
 *  rather than written out as whatever the raw bytes happened to be. */
async function inflateEntry(archive: Buffer, entry: ZipEntry): Promise<Buffer> {
  if (entry.localHeaderOffset + 30 > archive.length || archive.readUInt32LE(entry.localHeaderOffset) !== LOCAL_SIGNATURE) {
    throw new AppError(422, `The engine archive's entry for "${entry.name}" does not point at a valid record — refusing to extract it.`);
  }
  const nameLength = archive.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = archive.readUInt16LE(entry.localHeaderOffset + 28);
  const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const raw = archive.subarray(start, start + entry.compressedSize);

  if (entry.compressionMethod === 0) return Buffer.from(raw);
  if (entry.compressionMethod === 8) return Buffer.from(await inflateRawAsync(raw));
  throw new AppError(
    422,
    `The engine archive compresses "${entry.name}" with method ${entry.compressionMethod}, which this installer does not read. ` +
      `llama.cpp releases use store and deflate only.`
  );
}

/* ── the proof that it runs ─────────────────────────────────────────────────────────────────── */

/**
 * Spawn the freshly-installed binary with `--version` and require an answer.
 *
 * WHY THIS IS THE STEP THAT DECIDES "INSTALLED". Everything before it proves bytes moved and files
 * appeared. None of it proves the file can execute: a wrong-architecture binary, a glibc build on
 * musl, a missing shared library and an ABI mismatch between `llama-server` and `libggml` ALL extract
 * perfectly. Each one then fails at the first real inference — minutes or days later, to an operator
 * who was told the install succeeded and is now debugging the model, the settings or the network.
 * Twenty seconds and one process is a very cheap way to move that discovery to the moment of the
 * click.
 *
 * A NON-ZERO EXIT IS STILL AN ANSWER when there is output, and that is not laxity: llama.cpp has
 * changed which of `--version`/`--help` exits zero across releases, while a binary that cannot load
 * produces no output at all and dies on a signal. So the test is "did it say something recognisable",
 * with the string kept as evidence.
 *
 * Reviewed for sonarjs/no-os-command-from-path: `binaryPath` is ALWAYS an absolute path built by
 * this file from its own destination directory, so the OS is never asked to search; the single
 * argument is passed in an array with no shell.
 */
async function runVersionProbe(binaryPath: string): Promise<{ ok: true; output: string } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: true; output: string } | { ok: false; message: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let output = "";
    let child: ReturnType<typeof spawn>;
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // Nothing further to try; the exit handler below will not fire, and `finish` is idempotent.
      }
      finish({ ok: false, message: `it did not answer within ${Math.round(nativeEngineProbeTimeoutMs / 1000)} seconds and was killed.` });
    }, nativeEngineProbeTimeoutMs);
    timer.unref?.();

    try {
      child = spawn(binaryPath, ["--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      finish({ ok: false, message: `it could not be started at all (${(error as Error).message}).` });
      return;
    }

    // llama.cpp prints its version banner to stderr, not stdout. Both are collected because which
    // one it uses has changed between releases and pinning that would make the probe brittle for no
    // benefit.
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => finish({ ok: false, message: `it could not be started (${error.message}).` }));
    child.on("exit", (code, signal) => {
      const text = output.trim();
      if (text.length > 0) return finish({ ok: true, output: text });
      finish({
        ok: false,
        message: signal
          ? `it was killed by ${signal} and printed nothing — usually a binary for the wrong architecture, or one missing a shared library.`
          : `it exited with code ${code} and printed nothing — usually a binary for the wrong architecture, or one missing a shared library.`
      });
    });
  });
}

/** Remove an installed release from disk and forget its rows. Exposed so an operator who wants to
 *  reinstall, or reclaim the space, does not have to reach for a shell on the server. */
export async function removeNativeEngine(releaseTag: string, io: NativeEngineIo = defaultNativeEngineIo): Promise<void> {
  const existing = (await prisma.nativeEngineInstall.findFirst({ orderBy: { createdAt: "desc" } })) as InstallRecord | null;
  if (existing && IN_FLIGHT.has(existing.status)) {
    throw new AppError(409, "An install is still running. Cancel it first, then remove the engine.");
  }
  await removeQuietly(io.engineDirectory(releaseTag));
  await prisma.nativeEngineInstall.deleteMany({ where: { releaseTag } });
}

/** Every release directory currently on this host. Used by `resolveServerBinary`'s fallback and by
 *  nothing else; returns `[]` for a root that does not exist, which is the ordinary first state. */
export async function listInstalledReleases(io: NativeEngineIo = defaultNativeEngineIo): Promise<string[]> {
  try {
    const entries = await readdir(io.engineRoot(), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
