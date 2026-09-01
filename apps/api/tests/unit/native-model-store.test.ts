/**
 * THE MODEL STORE — the four refusals that stand between "a request returned 200" and "this file is
 * a language model", plus the two properties that make a crash survivable.
 *
 * WHY EVERY ONE OF THESE IS A TEST AND NOT A CODE REVIEW: each failure below is one that LOOKS LIKE
 * SUCCESS at the moment it happens. A truncated transfer leaves a file. A 404 page saved under a
 * `.gguf` name is a file. A disk that fills at 94% leaves a file. None of them announces itself, and
 * every one of them surfaces minutes or hours later as `llama-server` refusing to start, at which
 * point the operator is debugging the runtime instead of the download.
 *
 * ── WHAT IS REAL HERE, AND WHY ──────────────────────────────────────────────────────────────
 *
 * The FILESYSTEM is real. These tests write actual bytes into an actual temporary directory, and
 * assert on actual files. A test that stubbed `rename` would prove nothing whatsoever about the
 * atomic-rename property this service exists to provide, and a test that stubbed the hash would
 * prove nothing about the measurement it records. Only two things are faked: the network, and how
 * full the developer's laptop happens to be.
 *
 * The DATABASE is a small stateful in-memory table rather than `vi.fn()` stubs, because almost every
 * assertion here is about what the ROW says after a sequence of writes. Against call-order stubs
 * "the row ends up failed, not ready" is not expressible.
 *
 * The CATALOGUE ENTRY is synthetic for the transfer tests, and that is the one substitution worth
 * defending. The size-plausibility band is a ratio against the model's derived weight size, and the
 * smallest real catalogue entry derives to ~930 MB — so a test that exercised the band with a real
 * entry would have to write half a gigabyte and hash it. A scaled-down entry runs the REAL
 * `nativeDownloadSizeProblem`, the REAL magic-byte check and the REAL rename against a two-kilobyte
 * file. The real catalogue's own numbers are pinned by native-model-fit.test.ts, which is where that
 * belongs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

/**
 * A catalogue entry small enough to download in a test. 3,300 parameters at Q4_K_M's 4.83 bits per
 * weight, with the 1.05 safety factor, derives to ~2,092 bytes — so the plausible band is roughly
 * 1,150 to 3,556 bytes and a 2,000-byte file sits comfortably inside it.
 */
const { TINY } = vi.hoisted(() => ({
  TINY: {
    id: "tiny-test-model-q4_k_m",
    displayName: "Tiny Test Model",
    parameterCountB: 0.0000033,
    quantisation: "Q4_K_M" as const,
    repo: "bartowski/Tiny-Test-Model-GGUF",
    file: "Tiny-Test-Model-Q4_K_M.gguf",
    layers: 4,
    kvHeads: 2,
    headDim: 64,
    maxContextTokens: 4096,
    recommendedContextTokens: 2048,
    goodAt: "existing in a test",
    weakAt: "existing anywhere else"
  }
}));

// PARTIAL mock, and it replaces exactly ONE function: `findNativeModel` answers for the synthetic id
// and delegates to the real catalogue for everything else. `nativeDownloadSizeProblem`,
// `nativeModelWeightBytes`, `isNativeDownloadHostAllowed` and `nativeModelDownloadUrl` all stay real
// and all run against the entry above — which is the point, since they are what is under test.
vi.mock("@timesheet/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@timesheet/shared")>();
  return {
    ...actual,
    findNativeModel: (id: string) => (id === TINY.id ? TINY : actual.findNativeModel(id))
  };
});

const {
  assertAllowedDownloadUrl,
  assertRoomForModel,
  cancelNativeDownload,
  deleteNativeModel,
  ggufMagicProblem,
  listNativeDownloads,
  nativeDownloadDiskMarginBytes,
  recordNativeBenchmark,
  runNativeDownload,
  startNativeDownload
} = await import("../../src/services/native-model-store.service.js");
type NativeStoreIo = import("../../src/services/native-model-store.service.js").NativeStoreIo;

const { isNativeDownloadHostAllowed, nativeDownloadSizeProblem, nativeModelDownloadUrl, nativeModelStoredFileName, nativeModelWeightBytes } =
  await import("@timesheet/shared");

const GIB = 1024 ** 3;

/* ── the in-memory store ────────────────────────────────────────────────────────────────────── */

type Row = Record<string, unknown> & { id: string; modelId: string; status: string };

function fakeClient(): { client: PrismaClient; rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  let nextId = 1;

  const find = (where: { id?: string; modelId?: string }): Row | null => {
    if (where.id) return rows.get(where.id) ?? null;
    return [...rows.values()].find((row) => row.modelId === where.modelId) ?? null;
  };

  const table = {
    findMany: async () => [...rows.values()].sort((a, b) => Number(b.createdAt) - Number(a.createdAt)),
    findUnique: async ({ where }: { where: { id?: string; modelId?: string } }) => find(where),
    upsert: async ({ where, update, create }: { where: { modelId: string }; update: Row; create: Row }) => {
      const existing = find(where);
      if (existing) {
        Object.assign(existing, update, { updatedAt: new Date() });
        return existing;
      }
      const row = { id: `download-${nextId++}`, createdAt: new Date(), updatedAt: new Date(), ...create } as Row;
      rows.set(row.id, row);
      return row;
    },
    update: async ({ where, data }: { where: { id?: string; modelId?: string }; data: Row }) => {
      const existing = find(where);
      if (!existing) throw new Error("Record to update not found.");
      Object.assign(existing, data, { updatedAt: new Date() });
      return existing;
    },
    /** The CONDITIONAL write — a status guard in the WHERE clause, which is how the transfer
     *  advances a row to `downloading` without clobbering a `cancelled` that landed while the socket
     *  was opening. Modelled here (rather than stubbed away) because "count 0 and the row is
     *  untouched" is the whole assertion. */
    updateMany: async ({ where, data }: { where: { id?: string; status?: { in: string[] } }; data: Row }) => {
      const existing = find(where);
      if (!existing) return { count: 0 };
      if (where.status && !where.status.in.includes(String(existing.status))) return { count: 0 };
      Object.assign(existing, data, { updatedAt: new Date() });
      return { count: 1 };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const existing = find(where);
      if (!existing) throw new Error("Record to delete does not exist.");
      rows.delete(existing.id);
      return existing;
    }
  };

  return { client: { nativeModelDownload: table } as unknown as PrismaClient, rows };
}

/* ── the fake network ───────────────────────────────────────────────────────────────────────── */

let modelDir: string;
let store: ReturnType<typeof fakeClient>;

function ggufBytes(size: number): Uint8Array {
  const buffer = Buffer.alloc(size, 0x2a);
  buffer.write("GGUF", 0, "ascii");
  return new Uint8Array(buffer);
}

interface IoOptions {
  fetch?: NativeStoreIo["fetch"];
  freeDiskBytes?: NativeStoreIo["freeDiskBytes"];
  assertEgress?: NativeStoreIo["assertEgress"];
}

function makeIo(options: IoOptions = {}): NativeStoreIo {
  return {
    fetch: options.fetch ?? (async () => new Response(ggufBytes(2000), { headers: { "content-length": "2000" } })),
    freeDiskBytes: options.freeDiskBytes ?? (async () => 500 * GIB),
    modelDirectory: () => modelDir,
    assertEgress: options.assertEgress ?? (async () => undefined)
  };
}

/** A body plus the headers a real server would send with it. */
function bodyResponse(bytes: Uint8Array, extra: Record<string, string> = {}, status = 200): Response {
  return new Response(bytes, { status, headers: { "content-length": String(bytes.length), ...extra } });
}

async function seedQueuedRow(modelId = TINY.id): Promise<string> {
  const row = await runInTenant(store.client, () =>
    (store.client as unknown as { nativeModelDownload: { upsert: (args: unknown) => Promise<Row> } }).nativeModelDownload.upsert({
      where: { modelId },
      update: {},
      create: { modelId, status: "queued", bytesDownloaded: 0, bytesTotal: null, fileSizeBytes: null, sha256: null, filePath: null, error: null }
    })
  );
  return row.id;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

const finalName = () => path.join(modelDir, nativeModelStoredFileName(TINY.id));
const tempName = () => `${finalName()}.part`;

beforeEach(async () => {
  modelDir = await mkdtemp(path.join(os.tmpdir(), "timesphere-models-"));
  store = fakeClient();
});

afterEach(async () => {
  await rm(modelDir, { recursive: true, force: true });
});

/* ── where a model may come from ────────────────────────────────────────────────────────────── */

describe("the catalogue's own host allowlist", () => {
  it("accepts Hugging Face and the CDN hosts its redirects land on", () => {
    expect(isNativeDownloadHostAllowed("huggingface.co")).toBe(true);
    expect(isNativeDownloadHostAllowed("cdn-lfs.hf.co")).toBe(true);
    expect(isNativeDownloadHostAllowed("transfer.xethub.hf.co")).toBe(true);
    // Trailing dot is a legal absolute FQDN and names the same host.
    expect(isNativeDownloadHostAllowed("HuggingFace.co.")).toBe(true);
  });

  it("refuses the lookalikes a bare endsWith would wave through", () => {
    // THE CLASSIC WAY AN ALLOWLIST BECOMES DECORATIVE. Both of these end with an allowed string and
    // neither is Hugging Face.
    expect(isNativeDownloadHostAllowed("evilhuggingface.co")).toBe(false);
    expect(isNativeDownloadHostAllowed("nothf.co")).toBe(false);
    expect(isNativeDownloadHostAllowed("huggingface.co.attacker.test")).toBe(false);
    expect(isNativeDownloadHostAllowed("localhost")).toBe(false);
    expect(isNativeDownloadHostAllowed("169.254.169.254")).toBe(false);
  });

  it("derives every catalogue URL onto an allowed host", () => {
    // Not a tautology: it is the assertion that a future catalogue entry cannot introduce a host the
    // downloader would then refuse at the last moment, or worse, accept.
    expect(isNativeDownloadHostAllowed(new URL(nativeModelDownloadUrl(TINY)).hostname)).toBe(true);
  });

  it("refuses a non-allowlisted host and a plaintext scheme, naming what it refused", () => {
    expect(() => assertAllowedDownloadUrl("https://models.attacker.test/evil.gguf")).toThrow(/models\.attacker\.test/);
    expect(() => assertAllowedDownloadUrl("http://huggingface.co/a/resolve/main/b.gguf")).toThrow(/https/);
    expect(() => assertAllowedDownloadUrl("not-a-url")).toThrow(/not a valid download URL/);
  });
});

describe("a redirect off the allowlist", () => {
  it("is refused mid-transfer, because following one blindly is what makes the allowlist decorative", async () => {
    const id = await seedQueuedRow();
    const seen: string[] = [];
    const io = makeIo({
      fetch: async (url) => {
        seen.push(url);
        if (seen.length === 1) return new Response(null, { status: 302, headers: { location: "https://cdn.attacker.test/model.gguf" } });
        return bodyResponse(ggufBytes(2000));
      }
    });

    await runInTenant(store.client, () => runNativeDownload(id, io));

    const row = store.rows.get(id)!;
    expect(row.status).toBe("failed");
    expect(String(row.error)).toContain("cdn.attacker.test");
    // The second request was never made — the refusal happens before the socket, not after it.
    expect(seen).toHaveLength(1);
    expect(await exists(tempName())).toBe(false);
  });

  it("follows a redirect that stays on the allowlist, re-checking every hop through the egress gate", async () => {
    const id = await seedQueuedRow();
    const gateCalls: string[] = [];
    const io = makeIo({
      assertEgress: async (url) => {
        gateCalls.push(url);
      },
      fetch: async (url) => {
        if (url.includes("huggingface.co")) return new Response(null, { status: 302, headers: { location: "https://cdn-lfs.hf.co/blob/abc" } });
        return bodyResponse(ggufBytes(2000));
      }
    });

    await runInTenant(store.client, () => runNativeDownload(id, io));

    expect(store.rows.get(id)!.status).toBe("ready");
    // BOTH hops, not just the first. An `assertPublicEgressTarget` applied only to the URL we derived
    // ourselves is a check on the one value that was never in doubt.
    expect(gateCalls).toHaveLength(2);
    expect(gateCalls[0]).toContain("huggingface.co");
    expect(gateCalls[1]).toContain("cdn-lfs.hf.co");
  });
});

/* ── disk space ─────────────────────────────────────────────────────────────────────────────── */

describe("refusing to start without room", () => {
  it("names both numbers rather than saying 'insufficient space'", async () => {
    const needed = nativeModelWeightBytes(TINY).bytes + nativeDownloadDiskMarginBytes;
    const io = makeIo({ freeDiskBytes: async () => Math.floor(needed / 2) });

    await expect(runInTenant(store.client, () => assertRoomForModel(TINY, io))).rejects.toMatchObject({ statusCode: 507 });
    const error = await runInTenant(store.client, () => assertRoomForModel(TINY, io)).catch((e: Error) => e);
    // "Not enough disk" is not actionable. The two figures and the directory are.
    expect((error as Error).message).toMatch(/GB/);
    expect((error as Error).message).toContain("available");
    expect((error as Error).message).toContain(modelDir);
  });

  it("refuses BEFORE creating a job row, so a doomed download never appears in the list", async () => {
    const io = makeIo({ freeDiskBytes: async () => 1000 });
    await expect(runInTenant(store.client, () => startNativeDownload(TINY.id, "user-1", io))).rejects.toMatchObject({ statusCode: 507 });
    expect(await runInTenant(store.client, () => listNativeDownloads())).toEqual([]);
  });

  it("proceeds when the platform will not report free space at all", async () => {
    // Refusing every download on a filesystem Node cannot statfs would break the feature on exactly
    // the machines least able to diagnose it. The write's own failure is the backstop.
    const io = makeIo({ freeDiskBytes: async () => null });
    await expect(runInTenant(store.client, () => assertRoomForModel(TINY, io))).resolves.toBeUndefined();
  });
});

/* ── what a finished transfer has to survive ────────────────────────────────────────────────── */

describe("a complete, valid transfer", () => {
  it("records the MEASURED size and hash, renames off .part, and prefers the measurement over the derived estimate", async () => {
    const id = await seedQueuedRow();
    const payload = ggufBytes(2000);
    const io = makeIo({ fetch: async () => bodyResponse(payload) });

    await runInTenant(store.client, () => runNativeDownload(id, io));

    const row = store.rows.get(id)!;
    expect(row.status).toBe("ready");
    expect(row.fileSizeBytes).toBe(2000);
    expect(row.sha256).toBe(createHash("sha256").update(payload).digest("hex"));
    expect(row.filePath).toBe(finalName());

    // The rename actually happened, and nothing that looks complete was left behind.
    expect(await exists(finalName())).toBe(true);
    expect(await exists(tempName())).toBe(false);
    expect(await readFile(finalName())).toEqual(Buffer.from(payload));

    // THE POINT OF RECORDING A REAL SIZE. The catalogue's own figure is derived and errs high; the
    // row's `catalogue` carries the measured one folded in, so every downstream fit estimate runs on
    // the file rather than on the arithmetic.
    const listed = await runInTenant(store.client, () => listNativeDownloads());
    expect(nativeModelWeightBytes(TINY).source).toBe("derived-from-quantisation");
    expect(listed[0].catalogue!.fileSizeBytes).toBe(2000);
    expect(nativeModelWeightBytes(listed[0].catalogue!)).toEqual({ bytes: 2000, source: "catalogue" });
  });
});

describe("a truncated transfer", () => {
  it("does NOT become ready, even though the file it left behind looks fine", async () => {
    const id = await seedQueuedRow();
    // The server promises 4,000 bytes and delivers 1,600 — a stream that ended early with no error,
    // which is the failure that most resembles success.
    const io = makeIo({ fetch: async () => bodyResponse(ggufBytes(1600), { "content-length": "4000" }) });

    await runInTenant(store.client, () => runNativeDownload(id, io));

    const row = store.rows.get(id)!;
    expect(row.status).toBe("failed");
    expect(String(row.error)).toContain("ended early");
    expect(String(row.error)).toContain("4,000");
    // No file was promoted...
    expect(await exists(finalName())).toBe(false);
    // ...and the partial one is KEPT, because it is a real prefix of a real model and the next
    // attempt resumes from it.
    expect(await exists(tempName())).toBe(true);
  });
});

describe("a payload that is not a model", () => {
  it("rejects an HTML error page on its magic bytes and quotes what it actually got", async () => {
    const id = await seedQueuedRow();
    const html = Buffer.from(`<!DOCTYPE html><html><head><title>404</title></head><body>Not found</body></html>${"x".repeat(1900)}`);
    const io = makeIo({ fetch: async () => bodyResponse(new Uint8Array(html)) });

    await runInTenant(store.client, () => runNativeDownload(id, io));

    const row = store.rows.get(id)!;
    expect(row.status).toBe("failed");
    expect(String(row.error)).toContain("not a GGUF model");
    // The message names what WAS there, which is what turns "verification failed" into a diagnosis.
    expect(String(row.error)).toContain("<!DO");
    // A file that will never become a model by being resumed is removed, unlike a truncated one.
    expect(await exists(tempName())).toBe(false);
    expect(await exists(finalName())).toBe(false);
  });

  it("has a magic-byte predicate that accepts GGUF and nothing else", () => {
    expect(ggufMagicProblem(Buffer.from("GGUF\x03\x00\x00\x00"))).toBeNull();
    expect(ggufMagicProblem(Buffer.from("<?xml version"))).toMatch(/not a GGUF model/);
    expect(ggufMagicProblem(Buffer.alloc(0))).toMatch(/not a GGUF model/);
    // One byte out is still out — a check that tolerated an offset would tolerate a wrapper format.
    expect(ggufMagicProblem(Buffer.from("\x00GGUF"))).toMatch(/not a GGUF model/);
  });
});

describe("a payload of an implausible size", () => {
  it("is refused against the catalogue's derived estimate, with both figures named", async () => {
    const id = await seedQueuedRow();
    // Valid GGUF magic, honest Content-Length, and nowhere near the size this model should be.
    const io = makeIo({ fetch: async () => bodyResponse(ggufBytes(120)) });

    await runInTenant(store.client, () => runNativeDownload(id, io));

    const row = store.rows.get(id)!;
    expect(row.status).toBe("failed");
    expect(String(row.error)).toMatch(/should be roughly/);
    expect(await exists(finalName())).toBe(false);
  });

  it("has a band wide enough that a derived estimate never refuses a real file", () => {
    const expected = nativeModelWeightBytes(TINY).bytes;
    // The derivation is an average bits-per-weight with a safety factor; being 20% out on some entry
    // is expected and must not be a refusal. Being 90% out is a different file.
    expect(nativeDownloadSizeProblem(TINY, Math.round(expected * 0.8))).toBeNull();
    expect(nativeDownloadSizeProblem(TINY, Math.round(expected * 1.3))).toBeNull();
    expect(nativeDownloadSizeProblem(TINY, Math.round(expected * 0.2))).toMatch(/should be roughly/);
    expect(nativeDownloadSizeProblem(TINY, Math.round(expected * 4))).toMatch(/should be roughly/);
  });
});

/* ── cancel and resume ──────────────────────────────────────────────────────────────────────── */

describe("cancelling a download in flight", () => {
  it("stops the stream, marks the row cancelled, and removes the partial file", async () => {
    const id = await seedQueuedRow();
    let signalFirstChunk: () => void = () => undefined;
    const firstChunk = new Promise<void>((resolve) => {
      signalFirstChunk = resolve;
    });

    const io = makeIo({
      fetch: async (_url, init) => {
        let sent = false;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(ggufBytes(800));
              signalFirstChunk();
              return;
            }
            // Block until the cancel lands, then fail the way an aborted fetch does.
            await new Promise<void>((resolve) => {
              if (init.signal.aborted) return resolve();
              init.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            const abortError = new Error("The operation was aborted.");
            abortError.name = "AbortError";
            controller.error(abortError);
          }
        });
        return new Response(stream, { headers: { "content-length": "4000" } });
      }
    });

    await runInTenant(store.client, async () => {
      const running = runNativeDownload(id, io);
      await firstChunk;
      await cancelNativeDownload(id, io);
      await running;
    });

    const row = store.rows.get(id)!;
    expect(row.status).toBe("cancelled");
    // Cancel means "I do not want this", not "pause" — a gigabyte of nothing must not be left in the
    // model directory for somebody to find later.
    expect(await exists(tempName())).toBe(false);
    expect(await exists(finalName())).toBe(false);
    // And the operator's own action is never rewritten as an error.
    expect(row.error).toBeNull();
  });

  it("survives a cancel that lands WHILE the socket is still opening, rather than resurrecting the row", async () => {
    /* THE RACE, PINNED. `openStream` takes real time — DNS, TLS, and Hugging Face's redirect chain —
       and a Cancel pressed inside that window has already written `cancelled`. The transfer's next
       act used to be an UNCONDITIONAL `status: "downloading"` write, which put the row back in
       flight; the abort that cancel then triggered arrived in the catch to find an in-flight row and
       marked it `failed`. To the operator, Cancel appeared to break the download it had just
       stopped, and left an error message about an operation they aborted on purpose.

       Reproduced deterministically by cancelling from INSIDE the fake fetch — the one point that is
       provably before the status write and after the row exists. */
    const id = await seedQueuedRow();
    let cancelled = false;
    const io: NativeStoreIo = makeIo({
      fetch: async () => {
        if (!cancelled) {
          cancelled = true;
          await cancelNativeDownload(id, io);
        }
        return bodyResponse(ggufBytes(2000));
      }
    });

    await runInTenant(store.client, () => runNativeDownload(id, io));

    const row = store.rows.get(id)!;
    expect(row.status).toBe("cancelled");
    expect(row.error).toBeNull();
    // And nothing was left behind by the transfer that was already in the air.
    expect(await exists(tempName())).toBe(false);
    expect(await exists(finalName())).toBe(false);
  });

  it("is a no-op on a download that has already finished", async () => {
    const id = await seedQueuedRow();
    await runInTenant(store.client, () => runNativeDownload(id, makeIo()));
    expect(store.rows.get(id)!.status).toBe("ready");

    const after = await runInTenant(store.client, () => cancelNativeDownload(id, makeIo()));
    expect(after.status).toBe("ready");
    expect(await exists(finalName())).toBe(true);
  });
});

describe("resuming an interrupted transfer", () => {
  it("asks for the rest with a Range header and appends to what is already there", async () => {
    const id = await seedQueuedRow();
    const whole = ggufBytes(2000);
    await mkdir(modelDir, { recursive: true });
    await writeFile(tempName(), Buffer.from(whole.subarray(0, 700)));

    let sentRange: string | undefined;
    const io = makeIo({
      fetch: async (_url, init) => {
        sentRange = init.headers.range;
        return new Response(whole.subarray(700), {
          status: 206,
          headers: { "content-length": String(whole.length - 700), "content-range": `bytes 700-1999/2000` }
        });
      }
    });

    await runInTenant(store.client, () => runNativeDownload(id, io));

    expect(sentRange).toBe("bytes=700-");
    const row = store.rows.get(id)!;
    expect(row.status).toBe("ready");
    expect(row.fileSizeBytes).toBe(2000);
    expect(await readFile(finalName())).toEqual(Buffer.from(whole));
  });

  it("starts over when the server ignores Range and sends the whole file anyway", async () => {
    // Appending a full body onto a partial file gives a file of (partial + whole) bytes, which then
    // fails verification for a reason that has nothing to do with what actually went wrong.
    const id = await seedQueuedRow();
    const whole = ggufBytes(2000);
    await mkdir(modelDir, { recursive: true });
    await writeFile(tempName(), Buffer.from(whole.subarray(0, 700)));

    const io = makeIo({ fetch: async () => bodyResponse(whole) });
    await runInTenant(store.client, () => runNativeDownload(id, io));

    const row = store.rows.get(id)!;
    expect(row.status).toBe("ready");
    expect(row.fileSizeBytes).toBe(2000);
  });
});

/* ── deleting, and the benchmark's write path ───────────────────────────────────────────────── */

describe("deleting a stored model", () => {
  it("removes the file as well as the row", async () => {
    const id = await seedQueuedRow();
    await runInTenant(store.client, () => runNativeDownload(id, makeIo()));
    expect(await exists(finalName())).toBe(true);

    await runInTenant(store.client, () => deleteNativeModel(id, makeIo()));

    expect(await exists(finalName())).toBe(false);
    expect(store.rows.has(id)).toBe(false);
  });

  it("refuses while a download is still running, so the two cannot race over one file", async () => {
    const id = await seedQueuedRow();
    await expect(runInTenant(store.client, () => deleteNativeModel(id, makeIo()))).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("the store as the settings screen first sees it", () => {
  it("is an empty list and never an error", async () => {
    await expect(runInTenant(store.client, () => listNativeDownloads())).resolves.toEqual([]);
  });

  it("carries a benchmark back on the row once one has been recorded", async () => {
    const id = await seedQueuedRow();
    await runInTenant(store.client, () => runNativeDownload(id, makeIo()));

    const row = await runInTenant(store.client, () =>
      recordNativeBenchmark(TINY.id, { timeToFirstTokenMs: 900, tokensPerSecond: 12.5, outputTokens: 64, totalMs: 6000, suggestedMaxOutputTokens: 660 })
    );

    expect(row.benchmark).toMatchObject({ tokensPerSecond: 12.5, timeToFirstTokenMs: 900, suggestedMaxOutputTokens: 660 });
    // The words matter as much as the number: this figure REPLACES an estimate that says it is one.
    expect(row.benchmark!.basis).toContain("Measured on this machine");
    expect(row.id).toBe(id);
  });
});
