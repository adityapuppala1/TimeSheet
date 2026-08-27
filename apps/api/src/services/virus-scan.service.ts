/**
 * WHAT: scans an uploaded file's bytes for malware BEFORE they are written anywhere reachable.
 *
 * THE ORDERING IS THE WHOLE POINT, and it is the thing the request asked for by name: scan then
 * upload, never upload then scan. In this app that distinction is already structural — multer
 * writes to the STAGING tree, which `config/storage-paths.ts` marks non-public so `/uploads` cannot
 * name it at all, and `attachment-storage.service.ts#processUpload` is what promotes bytes into the
 * documents tree. The scan goes in that gap. A file that fails never becomes addressable, and a
 * file that cannot be scanned never becomes addressable either.
 *
 * WHY clamd OVER A TCP SOCKET AND NOT A LIBRARY. ClamAV is the only self-hostable engine with a
 * stable daemon protocol, and its INSTREAM command is about forty lines of `net.Socket` — every npm
 * wrapper for it is a thin shim over the same bytes plus a dependency that must be trusted with the
 * one code path that exists to establish trust. The protocol is: `zINSTREAM\0`, then length-prefixed
 * chunks, then a zero-length chunk, then read one line back.
 *
 * WHAT A SIGNATURE SCANNER DOES AND DOES NOT COVER, because "no XSS or VAPT can be uploaded" is a
 * larger claim than any scanner delivers:
 *   - It catches KNOWN malware by signature. That is what it is for and it is worth having.
 *   - It does not catch a novel payload, and it does not make an HTML file safe.
 *   - The defences that actually stop stored XSS here are the extension allow-list in
 *     `middleware/upload.ts` (which already excludes .html, .js and .svg for exactly this reason)
 *     and the `Content-Disposition: attachment` header on `/uploads`. This service is a layer on
 *     top of those, not a replacement for them, and claiming otherwise would be the more dangerous
 *     error than not having it.
 *
 * OFF BY DEFAULT, per workspace. A deployment with no clamd reachable would otherwise be unable to
 * accept a single attachment the moment this shipped. When it is ON, an unreachable scanner REFUSES
 * the upload — an "enabled" scanner that quietly passes files through when it cannot reach the
 * engine is worse than no scanner, because it is believed.
 */
import net from "node:net";
import { prisma } from "../config/prisma.js";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.js";

export interface ScanVerdict {
  scanned: boolean;
  clean: boolean;
  /** The signature clamd matched, when it found one — recorded and shown, never guessed at. */
  signature?: string;
  engine?: string;
}

/** clamd's own default. A stream larger than its `StreamMaxLength` is refused by the daemon, so
 *  matching the default here turns a confusing daemon error into a clear one of ours. */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** Long enough for a large archive on a busy daemon, short enough that a wedged scanner surfaces
 *  as an error rather than as an upload that never returns. */
const SCAN_TIMEOUT_MS = 30_000;

/**
 * Sends one buffer to clamd via INSTREAM and returns its verdict line.
 *
 * Rejects rather than resolving on any transport problem, so the caller can distinguish "the file
 * is infected" from "I could not tell" — two outcomes that must never be collapsed, because one of
 * them is a reason to refuse the upload and the other is a reason to refuse it AND page somebody.
 */
/**
 * clamd NUL-terminates its reply to every `z`-prefixed command, and `String.trim()` does not
 * treat a NUL as whitespace. So a reply of `stream: OK` followed by one failed an `/OK$/` test,
 * and EVERY CLEAN FILE was refused as unscannable. Found by a test that speaks the real protocol
 * instead of mocking the socket, which is the entire reason that test is written the way it is.
 *
 * `String.fromCharCode(0)` rather than a literal or an escape sequence: a raw NUL in source is
 * invisible in every diff and review, and this file genuinely ended up carrying two of them while
 * this was being written. In ONE place, so the verdict parser and the connectivity check cannot
 * disagree about what a reply looks like.
 */
function stripNuls(raw: string): string {
  return raw.split(String.fromCharCode(0)).join('').trim();
}

/**
 * One connection, one command, one reply — the only place this file talks to a socket.
 *
 * Both callers (the scan and the connectivity check) had their own copy of this, identical down to
 * the `settled` guard, which `sonarjs/no-identical-functions` correctly refused. More importantly a
 * second copy is a second place for the teardown to be got wrong, and this one's whole job is to
 * make sure exactly one of resolve/reject fires and the socket always dies.
 *
 * `writeBody` runs after the command is sent, for INSTREAM's length-prefixed frames. PING and
 * VERSION pass nothing and just read the reply.
 */
function talkToClamd(
  host: string,
  port: number,
  command: string,
  timeoutMs: number,
  writeBody?: (socket: net.Socket) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let response = "";
    let settled = false;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => done(() => reject(new Error(`clamd did not answer within ${timeoutMs / 1000}s`))));
    socket.on("error", (error) => done(() => reject(error)));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.on("end", () => done(() => resolve(stripNuls(response))));

    socket.on("connect", () => {
      // `z` prefix = NUL-terminated command, which is the form clamd documents.
      socket.write(`z${command}${String.fromCharCode(0)}`);
      writeBody?.(socket);
    });
  });
}

function clamdScan(buffer: Buffer, host: string, port: number): Promise<string> {
  return talkToClamd(host, port, "INSTREAM", SCAN_TIMEOUT_MS, (socket) => {
    // 64KB chunks, each preceded by its length as a big-endian uint32. clamd reads until it sees
    // a zero-length chunk, which is the terminator.
    const CHUNK = 64 * 1024;
    for (let offset = 0; offset < buffer.length; offset += CHUNK) {
      const slice = buffer.subarray(offset, offset + CHUNK);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(slice.length, 0);
      socket.write(header);
      socket.write(slice);
    }
    socket.write(Buffer.from([0, 0, 0, 0]));
  });
}

/** Reads the workspace's own setting. Re-read per upload rather than cached: switching scanning on
 *  must take effect on the next file, not after a process restart. */
async function scanSettings(): Promise<{ enabled: boolean; host: string; port: number; maxBytes: number }> {
  const row = await prisma.globalTicketSettings.findUnique({
    where: { id: "global" },
    select: { virusScanEnabled: true }
  });
  return {
    enabled: Boolean(row?.virusScanEnabled),
    host: env.CLAMAV_HOST || "127.0.0.1",
    port: env.CLAMAV_PORT,
    maxBytes: DEFAULT_MAX_BYTES
  };
}

/**
 * Scans a buffer and THROWS if it must not be stored.
 *
 * Throwing rather than returning a verdict the caller has to remember to check is deliberate: this
 * is the one call in the upload path whose whole value is that it cannot be forgotten. A caller who
 * ignores a returned boolean writes an infected file; a caller who ignores an exception does not
 * exist.
 */
export async function assertUploadIsClean(buffer: Buffer, originalName: string): Promise<ScanVerdict> {
  const settings = await scanSettings();
  if (!settings.enabled) return { scanned: false, clean: true };

  if (buffer.length > settings.maxBytes) {
    throw new AppError(
      413,
      `"${originalName}" is larger than the ${Math.round(settings.maxBytes / 1024 / 1024)}MB the virus scanner accepts, so it can't be checked.`
    );
  }

  let raw: string;
  try {
    raw = await clamdScan(buffer, settings.host, settings.port);
  } catch (error) {
    // FAILS CLOSED, and this is the line that makes the setting mean something. An admin who turned
    // scanning on is told files are scanned; letting one through unscanned because the daemon is
    // down would make that statement false at exactly the moment it matters.
    throw new AppError(
      503,
      `"${originalName}" couldn't be scanned for malware, so it wasn't stored. The virus scanner is unreachable (${(error as Error).message}). An admin can turn scanning off in Workspace Settings if this is expected.`
    );
  }

  // clamd answers `stream: OK` or `stream: <Signature> FOUND`, and `... ERROR` for its own faults.
  if (/\bOK\s*$/.test(raw)) return { scanned: true, clean: true, engine: "clamav" };

  // Split rather than a regex. `/stream:\s*(.+?)\s+FOUND/` reads fine and drew a `slow-regex`
  // warning for real reasons — a lazy `.+?` followed by `\s+` backtracks — and while a clamd reply
  // is short enough that it could never matter, the string operations below are both faster and
  // easier to be sure about than an argument for why a catastrophic pattern is safe here.
  const foundAt = raw.indexOf(" FOUND");
  if (foundAt > -1) {
    const afterPrefix = raw.slice(raw.indexOf("stream:") + "stream:".length, foundAt).trim();
    const signature = afterPrefix || "an unnamed signature";
    throw new AppError(422, `"${originalName}" was rejected: the virus scanner identified it as ${signature}.`);
  }

  // Anything else is the daemon reporting a problem with itself. Same reasoning as the catch above.
  throw new AppError(503, `"${originalName}" couldn't be scanned for malware, so it wasn't stored. The scanner said: ${raw || "(no response)"}`);
}

/**
 * Connectivity check for the settings screen, mirroring `/mail/test-connection`'s contract: a
 * failure is an ANSWER, returned as `{ ok: false }`, not an exception.
 *
 * Uses clamd's `PING`/`PONG` and `VERSION`, so it proves the daemon is actually speaking the
 * protocol rather than merely that a TCP port is open — a port that accepts a connection and then
 * says nothing is the failure mode that looks like success.
 */
export async function testVirusScanner(): Promise<{ ok: boolean; message: string; version?: string }> {
  const host = env.CLAMAV_HOST || "127.0.0.1";
  const port = env.CLAMAV_PORT;

  // Five seconds, not the scan's thirty: PING is a round trip with no work behind it, and an admin
  // waiting on a settings button should be told quickly.
  const command = (cmd: string) => talkToClamd(host, port, cmd, 5000);

  try {
    const pong = await command("PING");
    if (!/PONG/.test(pong)) return { ok: false, message: `Something is listening on ${host}:${port} but it isn't clamd — it answered "${pong}".` };
    const version = await command("VERSION").catch(() => "");
    return { ok: true, message: `Connected to clamd at ${host}:${port}.`, version: version || undefined };
  } catch (error) {
    return {
      ok: false,
      message: `Couldn't reach clamd at ${host}:${port}: ${(error as Error).message}. Set CLAMAV_HOST/CLAMAV_PORT, or leave scanning off.`
    };
  }
}
