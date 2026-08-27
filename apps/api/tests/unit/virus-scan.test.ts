/**
 * The upload malware gate, tested against a real socket speaking clamd's protocol.
 *
 * WHY A FAKE DAEMON RATHER THAN A MOCKED MODULE. What is being tested is the wire protocol — the
 * `zINSTREAM\0` command, the big-endian length prefixes, the zero-length terminator, and the shape
 * of the reply. Mocking `net` would assert that the code calls the functions it calls, which is not
 * the thing that breaks. A tiny TCP server that speaks clamd back is barely more work and tests the
 * only part that can actually be wrong.
 *
 * THE CENTRAL PROPERTY IS THE FAIL-CLOSED ONE. "Scanning is on but the scanner is unreachable" must
 * refuse the upload. An enabled scanner that passes files through when it cannot reach the daemon
 * is worse than no scanner, because an admin has been told files are scanned — so that case gets
 * as much attention here as an actual detection.
 */
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = { virusScanEnabled: true };
vi.mock("../../src/config/prisma.js", () => ({
  prisma: { globalTicketSettings: { findUnique: async () => settings } }
}));

let port = 0;
const envMock = { CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: 0 };
vi.mock("../../src/config/env.js", () => ({ env: new Proxy({}, { get: (_t, k) => (envMock as never)[k] }) }));

const { assertUploadIsClean, testVirusScanner } = await import("../../src/services/virus-scan.service.js");

/** A stand-in clamd. `reply` is what it answers after the stream terminator arrives. */
function fakeClamd(reply: (received: Buffer) => string | null): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (data) => {
        chunks.push(data);
        const all = Buffer.concat(chunks);
        const text = all.toString("latin1");
        // PING is answered immediately; INSTREAM waits for the four zero bytes that end the stream.
        if (text.startsWith("zPING")) {
          socket.end("PONG\0");
          return;
        }
        if (text.startsWith("zVERSION")) {
          socket.end("ClamAV 1.0.0/27000/Thu Jan  1 00:00:00 2026\0");
          return;
        }
        if (all.length >= 4 && all.subarray(all.length - 4).equals(Buffer.from([0, 0, 0, 0]))) {
          const answer = reply(all);
          if (answer === null) socket.destroy(); // simulates a daemon that dies mid-scan
          else socket.end(answer);
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as net.AddressInfo).port;
      envMock.CLAMAV_PORT = port;
      resolve(server);
    });
  });
}

let server: net.Server | undefined;
beforeEach(() => {
  settings.virusScanEnabled = true;
});
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = undefined;
});

describe("assertUploadIsClean", () => {
  it("does nothing at all when the workspace has scanning off", async () => {
    settings.virusScanEnabled = false;
    // No daemon is listening on this port, and that must not matter: the default configuration of
    // every existing deployment has no scanner, and uploads have to keep working.
    envMock.CLAMAV_PORT = 1;
    await expect(assertUploadIsClean(Buffer.from("anything"), "notes.txt")).resolves.toEqual({ scanned: false, clean: true });
  });

  it("passes a clean file", async () => {
    server = await fakeClamd(() => "stream: OK\0");
    await expect(assertUploadIsClean(Buffer.from("harmless"), "notes.txt")).resolves.toMatchObject({ scanned: true, clean: true });
  });

  it("refuses an infected file and names the signature", async () => {
    server = await fakeClamd(() => "stream: Eicar-Test-Signature FOUND\0");
    await expect(assertUploadIsClean(Buffer.from("x5o!"), "invoice.pdf")).rejects.toThrow(/Eicar-Test-Signature/);
    await expect(assertUploadIsClean(Buffer.from("x5o!"), "invoice.pdf")).rejects.toThrow(/invoice\.pdf/);
  });

  it("REFUSES the upload when the scanner cannot be reached", async () => {
    // The property the whole feature rests on. Nothing is listening here.
    envMock.CLAMAV_PORT = 1;
    await expect(assertUploadIsClean(Buffer.from("harmless"), "notes.txt")).rejects.toThrow(/couldn't be scanned/i);
  });

  it("refuses when the daemon drops the connection mid-scan", async () => {
    // A half-answer is not a pass. This is the failure a naive implementation reports as success,
    // because it never received the word FOUND.
    server = await fakeClamd(() => null);
    await expect(assertUploadIsClean(Buffer.from("harmless"), "notes.txt")).rejects.toThrow(/couldn't be scanned/i);
  });

  it("refuses when the daemon reports its own error", async () => {
    server = await fakeClamd(() => "INSTREAM size limit exceeded. ERROR\0");
    await expect(assertUploadIsClean(Buffer.from("big"), "big.zip")).rejects.toThrow(/couldn't be scanned/i);
  });

  it("sends the file's actual bytes, length-prefixed and terminated", async () => {
    // Pins the protocol, which is the part a refactor would silently break: a scanner that receives
    // the wrong bytes answers OK to everything.
    let received: Buffer | undefined;
    server = await fakeClamd((all) => {
      received = all;
      return "stream: OK\0";
    });
    const payload = Buffer.from("the quick brown fox");
    await assertUploadIsClean(payload, "fox.txt");

    const text = received!.toString("latin1");
    expect(text.startsWith("zINSTREAM\0")).toBe(true);
    // After the command: a 4-byte big-endian length, the payload, then four zero bytes.
    const body = received!.subarray("zINSTREAM\0".length);
    expect(body.readUInt32BE(0)).toBe(payload.length);
    expect(body.subarray(4, 4 + payload.length).equals(payload)).toBe(true);
    expect(body.subarray(body.length - 4).equals(Buffer.from([0, 0, 0, 0]))).toBe(true);
  });
});

describe("testVirusScanner", () => {
  it("reports a reachable daemon and its version", async () => {
    server = await fakeClamd(() => "stream: OK\0");
    const result = await testVirusScanner();
    expect(result.ok).toBe(true);
    expect(result.version).toMatch(/ClamAV/);
  });

  it("returns a failure rather than throwing when nothing is listening", async () => {
    envMock.CLAMAV_PORT = 1;
    const result = await testVirusScanner();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/couldn't reach clamd/i);
  });
});
