/**
 * WHAT: how this deployment OBTAINS `llama-server` — which published build belongs on this exact
 * machine, where it may be fetched from, which entries of the archive may be written to disk, and
 * the three situations in which the honest answer is "not here, run a sidecar instead".
 *
 * ── WHY THIS EXISTS AT ALL, AND WHY IT IS A REVERSAL ────────────────────────────────────────
 *
 * config/native-ai.ts and native-runtime.service.ts both stated, in their headers, that nothing in
 * this codebase downloads or builds a llama.cpp binary — the operator installs one and points
 * `NATIVE_AI_SERVER_BIN` at it. That was defensible while the block was a supervisor. It stopped
 * being defensible the moment the product's promise became "pick a model, download it, run it": the
 * model downloads and verifies perfectly, and then the panel ends at "install llama.cpp yourself",
 * which is a dead end wearing an instruction's clothing. A feature whose last step cannot be taken
 * from the screen that offers it is not a feature.
 *
 * WHAT DID NOT CHANGE is the part that mattered: nothing is fetched at BOOT, ever. Downloading and
 * then EXECUTING a binary from the internet is a decision an operator makes knowingly, with the
 * release, the host, the asset name and the size in front of them. That is why every value this
 * file computes is designed to be RENDERED BEFORE THE CLICK rather than only logged after it.
 *
 * ── WHY A PINNED TAG AND NEVER "LATEST" ─────────────────────────────────────────────────────
 *
 * `.../releases/latest/...` resolves at request time, so two installs of the same TimeSphere build,
 * a week apart, get different binaries — and the second one's bug report is unreproducible against
 * the first one's machine. Worse, it hands whoever can publish a release the ability to change what
 * an existing deployment executes on its next install. So the tag is a CONSTANT in this file,
 * reviewed like any other constant, and it is recorded on the install row so the answer to "what is
 * this box running" is a stored fact rather than an inference.
 *
 * THE ESCAPE HATCH IS NARROW ON PURPOSE. `NATIVE_AI_ENGINE_RELEASE` lets an operator name a
 * different tag — for an air-gapped mirror, or to move ahead of this build's pin without waiting for
 * a release of ours — and it is validated against {@link nativeEngineReleaseTagPattern} so it can
 * only ever be another pin. There is deliberately no value that means "newest".
 *
 * ── WHAT IS VERIFIED, AND WHAT IS ONLY RECORDED ─────────────────────────────────────────────
 *
 * The archive's magic bytes are CHECKED (a zip that is not a zip is an error page), every entry name
 * is CHECKED against traversal, the extracted binary is CHECKED by running it, and the SHA-256 is
 * only RECORDED. That last one is the same admission `NativeModelDownload.sha256` makes and for the
 * same reason: this project cannot verify a hash it has not independently obtained, and writing an
 * invented constant into a security check would be worse than the gap it pretends to close. The
 * recorded hash is still worth having — it is what proves two installations hold the same binary,
 * and it is the raw material for pinning a real hash later.
 *
 * ── THE MUSL PROBLEM, WHICH IS THE WHOLE REASON THIS FILE HAS A REFUSAL PATH ────────────────
 *
 * llama.cpp's published Linux builds are glibc-linked. This app's own image is `node:24-alpine`,
 * which is musl. A glibc binary on musl does not fail with a diagnosis — it fails with
 * `no such file or directory` from the kernel's loader, naming a file that plainly exists, which is
 * one of the most confusing errors in Linux. Offering that download would therefore be worse than
 * offering nothing. So musl is DETECTED and REFUSED with the sidecar instructions attached, which is
 * the answer native-runtime.service.ts's header has recommended for containers since it was written.
 */

/* ── where a build may come from ────────────────────────────────────────────────────────────── */

/**
 * The upstream repository. Named as a constant rather than inlined into a URL because it appears in
 * the operator-facing sentence too, and those two must never be able to disagree about which
 * project's binary this is.
 */
export const nativeEngineRepo = "ggml-org/llama.cpp";

/**
 * The only hosts an engine archive may be fetched from, as suffixes — the same shape and the same
 * argument as `nativeDownloadHostSuffixes` in native-runtime.ts.
 *
 * `githubusercontent.com` is here because a GitHub release asset answers with a 302 to
 * `objects.githubusercontent.com` or `release-assets.githubusercontent.com`, which means refusing
 * redirects would refuse every real download and following them blindly would make the allowlist
 * decorative. Matched as "equal to, or ending in a dot plus", because a bare `endsWith` accepts
 * `evil-github.com` — which is the classic way an allowlist becomes a formality.
 */
export const nativeEngineHostSuffixes = ["github.com", "githubusercontent.com"] as const;

export function isNativeEngineHostAllowed(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return nativeEngineHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * The release this build installs.
 *
 * A REVIEWED CONSTANT, not a resolved "latest" — see the header. Bumping it is a one-line diff that
 * goes through review like any other, and the tag it names ends up on the install row, so an
 * operator can answer "which llama.cpp is this?" without guessing from a file date.
 */
export const nativeEnginePinnedReleaseTag = "b6099";

/** llama.cpp tags builds `b` followed by a build number. The pattern is what stops the environment
 *  override from being able to smuggle a path segment, a query string or the word "latest" into a
 *  URL this file constructs. */
export const nativeEngineReleaseTagPattern = /^b\d{3,7}$/;

export function isNativeEngineReleaseTag(tag: string): boolean {
  return nativeEngineReleaseTagPattern.test(tag.trim());
}

/* ── which build belongs on THIS machine ────────────────────────────────────────────────────── */

/** Which C library a Linux userland is built against. `null` everywhere it is not a question that
 *  has an answer (Windows, macOS) or on a Linux we could not read. */
export type NativeLibc = "glibc" | "musl";

/** The name `resolveServerBinary` looks for, without a platform extension. One definition, used by
 *  the installer that writes the file and the resolver that finds it. */
export const nativeEngineBinaryName = "llama-server";

/** What the executable is called once it is on disk here. */
export function nativeEngineBinaryFileName(platform: string): string {
  return platform === "win32" ? `${nativeEngineBinaryName}.exe` : nativeEngineBinaryName;
}

export interface NativeEngineAsset {
  /** The published asset's file name, shown to the operator before the click. */
  assetName: string;
  url: string;
  releaseTag: string;
  /**
   * ABOUT how big the download is, and the word "about" is load-bearing. This is a published-size
   * ballpark used for one job — letting an operator decide whether to press a button that spends
   * their bandwidth — and the REAL byte count is measured from what arrives and stored on the row.
   * Anything that needs a true size reads the measurement, never this.
   */
  approximateBytes: number;
  /** Every platform's build is published as a zip, including the Linux and macOS ones. Kept as an
   *  explicit field rather than inferred from the extension so the verifier is driven by the plan
   *  rather than by string-matching a filename it was handed. */
  archiveFormat: "zip";
}

/** Why there is no build for this machine. Each one is a genuinely different conversation, which is
 *  why they are separate codes and not one "unsupported". */
export type NativeEngineRefusalCode = "musl" | "unsupported-platform" | "unsupported-arch" | "bad-release-tag";

export type NativeEngineResolution =
  | { ok: true; asset: NativeEngineAsset }
  | { ok: false; code: NativeEngineRefusalCode; message: string };

/** The answer that is always available, on every platform, including the ones this cannot serve. It
 *  is quoted into every refusal below, because "no" without "instead, do this" is a dead end and a
 *  dead end is what this whole file was written to remove. */
export const nativeEngineSidecarInstructions =
  `Run llama.cpp as a separate service and point this process at it: start a container from ` +
  `ghcr.io/ggml-org/llama.cpp:server (or any host running llama-server) with the model mounted, then set ` +
  `NATIVE_AI_RUNTIME_MODE=external and NATIVE_AI_HOST/NATIVE_AI_PORT to its address. This process then supervises ` +
  `nothing and only dispatches to it, which is the documented answer for containers and the one this image is built for.`;

/**
 * WHICH ARCHIVE, FOR THIS PLATFORM, THIS ARCHITECTURE AND THIS LIBC — or the reason there is not
 * one, in words an operator can act on.
 *
 * PURE, AND SHARED WITH THE BROWSER ON PURPOSE. The settings screen has to state what it is about
 * to fetch, from where, and roughly how big, BEFORE the operator clicks — and a screen that computed
 * that from its own table would eventually promise a download the server then refuses. One function,
 * two callers, no second opinion.
 *
 * THE MUSL BRANCH COMES FIRST among the Linux answers and that ordering is the point: `linux/x64` on
 * Alpine matches a real published asset in every respect except the one that decides whether the
 * file can execute at all. Checking the architecture first and the libc second would hand a musl box
 * a glibc binary and a loader error naming a file that exists.
 */
export function resolveNativeEngineAsset(input: {
  platform: string;
  arch: string;
  /** `null` means "not a Linux question, or a Linux we could not read". See the caution below. */
  libc: NativeLibc | null;
  /** Defaults to this build's pin. Only ever another PIN — see {@link nativeEngineReleaseTagPattern}. */
  releaseTag?: string;
}): NativeEngineResolution {
  const tag = (input.releaseTag ?? nativeEnginePinnedReleaseTag).trim();
  if (!isNativeEngineReleaseTag(tag)) {
    return {
      ok: false,
      code: "bad-release-tag",
      message:
        `"${tag}" is not a llama.cpp release tag. Tags look like "${nativeEnginePinnedReleaseTag}" — a "b" followed by the build ` +
        `number. This build pins ${nativeEnginePinnedReleaseTag}; NATIVE_AI_ENGINE_RELEASE may name a different pin, but never "latest", ` +
        `because a build that changes underneath a deployment is an unreproducible bug report.`
    };
  }

  if (input.platform === "linux" && input.libc === "musl") {
    return {
      ok: false,
      code: "musl",
      message:
        `This host runs musl (Alpine), and llama.cpp publishes only glibc-linked Linux builds. A glibc binary on musl does not ` +
        `fail with a useful message — the kernel's loader reports "no such file or directory" for a file that is plainly there — ` +
        `so nothing is offered here rather than installing something that cannot run. ${nativeEngineSidecarInstructions}`
    };
  }

  const platformSlug = PLATFORM_SLUGS[input.platform];
  if (!platformSlug) {
    return {
      ok: false,
      code: "unsupported-platform",
      message:
        `llama.cpp publishes builds for Windows, Linux and macOS; this host reports "${input.platform}", which has none. ` +
        `${nativeEngineSidecarInstructions}`
    };
  }

  const archSlug = ARCH_SLUGS[input.arch];
  if (!archSlug || !platformSlug.arches.includes(archSlug)) {
    return {
      ok: false,
      code: "unsupported-arch",
      message:
        `There is no published ${platformSlug.label} build for the "${input.arch}" architecture at ${tag}. ` +
        `${nativeEngineSidecarInstructions}`
    };
  }

  const assetName = `llama-${tag}-bin-${platformSlug.prefix}-${archSlug}.zip`;
  return {
    ok: true,
    asset: {
      assetName,
      url: `https://github.com/${nativeEngineRepo}/releases/download/${tag}/${assetName}`,
      releaseTag: tag,
      approximateBytes: platformSlug.approximateBytes,
      archiveFormat: "zip"
    }
  };
}

/**
 * Platform → the asset-name fragment upstream uses, the architectures it publishes, and a ballpark
 * size. The Windows assets are the `cpu` variants deliberately: the CUDA ones need a matching
 * driver+toolkit on the host, and installing one on a box that has neither produces a binary that
 * starts and then fails at the first inference — which is a far worse outcome than the CPU build
 * this whole subsystem's fit estimator was written around anyway.
 */
const PLATFORM_SLUGS: Record<string, { prefix: string; label: string; arches: string[]; approximateBytes: number }> = {
  win32: { prefix: "win-cpu", label: "Windows", arches: ["x64", "arm64"], approximateBytes: 26 * 1024 * 1024 },
  linux: { prefix: "ubuntu", label: "Linux", arches: ["x64", "arm64"], approximateBytes: 22 * 1024 * 1024 },
  darwin: { prefix: "macos", label: "macOS", arches: ["x64", "arm64"], approximateBytes: 16 * 1024 * 1024 }
};

/** Node's `process.arch` → upstream's slug. Anything not here has no build, which the resolver says
 *  in words rather than by constructing a URL that 404s. */
const ARCH_SLUGS: Record<string, string> = { x64: "x64", arm64: "arm64" };

/* ── what may be written to disk out of the archive ─────────────────────────────────────────── */

/** The zip local-file-header magic, ASCII `PK\3\4`, at offset zero. */
export const zipMagicBytes = [0x50, 0x4b, 0x03, 0x04] as const;

/**
 * `null` when the first bytes are a zip's; otherwise the sentence to store on the row.
 *
 * Quotes what WAS there, printable characters only, for exactly the reason `ggufMagicProblem` does:
 * `<!DO` is an error page, `{"m` is a JSON error body, and naming it turns "verification failed"
 * into "you fetched a web page".
 */
export function zipMagicProblem(header: Uint8Array): string | null {
  const magic = zipMagicBytes;
  if (header.length >= magic.length && magic.every((byte, index) => header[index] === byte)) return null;
  let preview = "";
  for (const byte of header.subarray(0, 16)) preview += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
  return (
    `The downloaded engine archive is not a zip file — its first bytes are "${preview}" rather than "PK..". ` +
    `That is what an error page, a login redirect or a proxy response looks like once it has been saved under a .zip name.`
  );
}

/**
 * `null` when this archive entry's name is safe to write; otherwise the refusal, naming the entry.
 *
 * EXTRACTING AN ARCHIVE FROM THE INTERNET IS EXACTLY WHERE PATH TRAVERSAL BITES, and the mistake is
 * always the same shape: the extractor joins the destination directory to a name it was given and
 * trusts `path.join` to keep the result inside. It does not — `join(dir, "../../.ssh/authorized_keys")`
 * is a perfectly ordinary path outside `dir`, and on Windows `C:\evil` and `\\server\share` ignore
 * the base entirely.
 *
 * THIS REFUSES RATHER THAN SANITISES, and that is deliberate even though the installer also flattens
 * every entry to its basename (which would neutralise traversal on its own). A defence that only
 * works because of a second, unrelated decision one layer away is a defence that disappears the day
 * somebody changes the layout to preserve directories. An archive containing `..` is not an archive
 * with an awkward filename in it; it is an archive doing something no legitimate release does, and
 * the whole install should stop.
 */
export function nativeEngineEntryProblem(entryName: string): string | null {
  const name = entryName.replace(/\\/g, "/");
  if (name.trim() === "") return "The engine archive contains an entry with an empty name, which no legitimate release produces.";
  if (name.startsWith("/")) {
    return `The engine archive contains an absolute path ("${entryName}"). Refusing to extract it — an archive that names where it wants to be written is not a release, it is an attack.`;
  }
  // Windows drive letters and UNC paths, which `path.join` also honours over its own base.
  if (/^[a-zA-Z]:/.test(name) || name.startsWith("//")) {
    return `The engine archive contains an absolute Windows path ("${entryName}"). Refusing to extract it.`;
  }
  if (name.split("/").includes("..")) {
    return `The engine archive contains a path-traversal entry ("${entryName}"). Refusing to extract it — this is how an archive writes outside the directory it was told to use.`;
  }
  if (name.includes("\0")) return `The engine archive contains an entry with a NUL byte in its name ("${entryName}"). Refusing to extract it.`;
  return null;
}

/**
 * Which entries of a llama.cpp release zip this installer actually wants, and what each is called
 * once it lands.
 *
 * ONLY THE SERVER AND ITS SHARED LIBRARIES. A release zip carries a dozen example binaries
 * (`llama-cli`, `llama-bench`, `llama-quantize`, …) that this product never invokes, and every one
 * of them is another executable sitting in a directory this process wrote. `llama-server` needs the
 * `ggml`/`llama` shared objects beside it or it will not start, so those come too — and nothing else
 * does.
 *
 * FLATTENED TO THE BASENAME because upstream is not consistent about layout: the Linux and macOS
 * zips nest under `build/bin/`, the Windows one does not. A flat destination directory means
 * `resolveServerBinary` has one place to look regardless of which platform produced the archive.
 */
export function nativeEngineWantedEntry(entryName: string, platform: string): { keep: boolean; destName: string } {
  const base = entryName.replace(/\\/g, "/").split("/").pop() ?? "";
  if (base === "") return { keep: false, destName: "" };
  if (base === nativeEngineBinaryFileName(platform)) return { keep: true, destName: base };
  // Shared libraries, by extension. `.so.1` and friends are matched too — upstream ships versioned
  // sonames on Linux and a binary that cannot find its `libggml.so.0` is a binary that does not run.
  if (/\.(dll|dylib)$/i.test(base) || /\.so(\.\d+)*$/i.test(base)) return { keep: true, destName: base };
  return { keep: false, destName: "" };
}

/* ── the install job ────────────────────────────────────────────────────────────────────────── */

/**
 * An install's life. `installing` is its own state and not a flicker at the end of `verifying`,
 * because it is where the two slowest and most failure-prone steps live: extracting the archive and
 * then RUNNING the extracted binary to see whether it answers. An operator watching a bar frozen at
 * 100% deserves to know which of those is happening.
 */
export const nativeEngineInstallStatuses = ["queued", "downloading", "verifying", "installing", "ready", "failed", "cancelled"] as const;
export type NativeEngineInstallStatus = (typeof nativeEngineInstallStatuses)[number];

/** The statuses a UI keeps polling on — the conditional `refetchInterval` pattern this codebase uses
 *  for every long job, and the same list shape `nativeDownloadInFlightStatuses` provides. */
export const nativeEngineInstallInFlightStatuses: readonly NativeEngineInstallStatus[] = [
  "queued",
  "downloading",
  "verifying",
  "installing"
];

/** One attempt to put `llama-server` on this host's disk. The API shape, not the row shape. */
export interface NativeEngineInstallRow {
  id: string;
  status: NativeEngineInstallStatus;
  /** The release this attempt installed, recorded rather than re-derived — the pin can move between
   *  an install and the question "what is this box running". */
  releaseTag: string;
  assetName: string;
  sourceUrl: string;
  bytesDownloaded: number;
  /** From `Content-Length`. Null means the server would not say — a real outcome, not zero. */
  bytesTotal: number | null;
  /** MEASURED from the archive that arrived. Never the resolver's `approximateBytes`. */
  fileSizeBytes: number | null;
  /** RECORDED, not compared — see the header. */
  sha256: string | null;
  /** Absolute path of the installed `llama-server`, once it has proved it runs. Null before that. */
  binaryPath: string | null;
  /** What the binary said when it was asked its version. The evidence for "installed", stored so an
   *  operator sees the same string the installer accepted. */
  versionOutput: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Where `resolveServerBinary` found the binary it is going to spawn. Reported because "there is a
 *  llama-server" and "there is the one this panel installed" are different facts, and an operator
 *  debugging a version mismatch needs to know which. */
export type NativeEngineBinarySource = "configured" | "managed" | "path";

/**
 * Everything the engine step renders: what is installed, what would be installed here, and — when
 * nothing can be — why, with the sidecar instructions still attached.
 */
export interface NativeEngineReport {
  /** Resolved absolute path of `llama-server`, or null when this host has none. */
  binaryPath: string | null;
  binarySource: NativeEngineBinarySource | null;
  /** Why there is no binary, when there is none. Null when one was found. */
  problem: string | null;
  /** Whether an install would even be attempted here. `off`/`external` modes install nothing —
   *  there is no process on this host to give a binary to. */
  installable: boolean;
  /** What would be fetched, or the refusal. Rendered before the click, never after it. */
  resolution: NativeEngineResolution;
  platform: string;
  arch: string;
  libc: NativeLibc | null;
  /** The most recent attempt, so a page reload during a download still shows the progress bar. */
  install: NativeEngineInstallRow | null;
  /** Always present, on every platform, including the ones an install works on — an operator may
   *  prefer a sidecar anyway, and the instructions should not only appear on failure. */
  sidecarInstructions: string;
}
