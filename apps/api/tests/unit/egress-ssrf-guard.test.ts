/**
 * Four features let an admin type a URL that this SERVER then fetches: outbound webhooks
 * (services/webhook-dispatch.service.ts), the Google Chat incoming webhook and the Bot Framework
 * reply endpoint (services/chat-outbound.service.ts), and the BYOK OpenAI-compatible `baseUrl`
 * (services/ai.service.ts). All four used to accept anything `new URL()` parses — and
 * `z.string().url()`, which was the only guard on two of them, is happy with
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/`.
 *
 * That is server-side request forgery. The API sits INSIDE the deployment's trusted network, so
 * it can reach cloud instance metadata (which hands out IAM credentials to any process that
 * asks), a database on localhost, or an internal admin panel — none of which the caller could
 * reach directly. And a tenant SUPER_ADMIN is a CUSTOMER in the hosted product, not the
 * operator: controllers/platform-admin.controller.ts is the operator's console, not this one.
 *
 * Two of those surfaces made it worse by returning the result: `POST
 * /settings/ai/available-models` hands back the fetched list or the remote error message, and the
 * webhook test/retry routes hand back `http_<status>`. That turns a blind request into an
 * internal port scanner with a readable oracle.
 *
 * These tests pin utils/egress.ts, which is the single choke point all four now go through. The
 * cases that matter are the ones a string check would wave through: a HOSTNAME that resolves to
 * a private address (the reason DNS is resolved at all), an IPv4 address smuggled inside an IPv6
 * literal, and a name that resolves to one public AND one private address.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ default: { lookup: mockLookup }, lookup: mockLookup }));

/** Mutable so each test can put the guard in production (closed) or dev (open) mode. */
const mockEnv = { NODE_ENV: "production", ALLOW_PRIVATE_NETWORK_EGRESS: false };
vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));

const { assertPublicEgressTarget, egressUrlProblem, isBlockedAddress } = await import("../../src/utils/egress.js");

beforeEach(() => {
  mockLookup.mockReset();
  mockEnv.NODE_ENV = "production";
  mockEnv.ALLOW_PRIVATE_NETWORK_EGRESS = false;
});

describe("isBlockedAddress", () => {
  it.each([
    ["169.254.169.254", "AWS/Azure/GCP instance metadata — the highest-value SSRF target there is"],
    ["127.0.0.1", "loopback"],
    ["127.9.9.9", "the whole of 127/8 is loopback, not just .0.1"],
    ["10.1.2.3", "RFC 1918"],
    ["172.16.0.1", "RFC 1918 — the low edge of the /12"],
    ["172.31.255.254", "RFC 1918 — the high edge of the /12"],
    ["192.168.1.1", "RFC 1918"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["0.0.0.0", "this host on this network"],
    ["255.255.255.255", "broadcast — inside the 240/4 reserved block"]
  ])("blocks %s (%s)", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ["172.15.0.1", "just BELOW the RFC 1918 /12 — a naive /16 or string check gets this wrong"],
    ["172.32.0.1", "just ABOVE the RFC 1918 /12"],
    ["8.8.8.8", "ordinary public address"],
    ["93.184.216.34", "ordinary public address"]
  ])("allows %s (%s)", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it("sees the IPv4 hiding inside an IPv4-mapped IPv6 literal", () => {
    // ::ffff:127.0.0.1 IS loopback. Judging it as "some IPv6 address we don't recognise" is
    // exactly how a loopback target gets waved through by a guard that looks like it works.
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("64:ff9b::127.0.0.1")).toBe(true);
  });

  it("sees through the BRACKETS a URL wraps an IPv6 literal in", () => {
    // THE FORM THAT ACTUALLY REACHES THE GUARD, and the one this suite originally missed:
    // `new URL("http://[::1]/").hostname` is "[::1]" — brackets included — so `net.isIP` said
    // "not an IP", the IPv6 branch never ran, and a loopback target passed. The bare-address
    // cases above all passed the whole time; nothing was feeding the predicate the shape the URL
    // parser produces. Found by probing the running server, not by reading the code.
    expect(isBlockedAddress("[::1]")).toBe(true);
    expect(isBlockedAddress("[::ffff:127.0.0.1]")).toBe(true);
    expect(isBlockedAddress("[fe80::1]")).toBe(true);
    expect(isBlockedAddress("[2606:4700:4700::1111]")).toBe(false);
  });

  it("blocks IPv6 loopback, unique-local and link-local", () => {
    expect(isBlockedAddress("::1")).toBe(true);
    expect(isBlockedAddress("fc00::1")).toBe(true);
    expect(isBlockedAddress("fd12:3456::1")).toBe(true);
    expect(isBlockedAddress("fe80::1")).toBe(true);
  });

  it("allows a public IPv6 address", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("egressUrlProblem — the save-time shape check", () => {
  it("rejects a scheme that is not http(s), which `new URL()` accepts happily", () => {
    // This is the gap `z.string().url()` left: all of these parse.
    expect(egressUrlProblem("file:///etc/passwd")).toMatch(/http/);
    expect(egressUrlProblem("gopher://internal:70/")).toMatch(/http/);
    expect(egressUrlProblem("ftp://internal/")).toMatch(/http/);
  });

  it("rejects credentials embedded in the URL", () => {
    expect(egressUrlProblem("https://user:pass@example.com/hook")).toMatch(/username or password/);
  });

  it("rejects literal private, loopback and metadata addresses", () => {
    expect(egressUrlProblem("http://169.254.169.254/latest/meta-data/")).toMatch(/private or loopback/);
    expect(egressUrlProblem("http://127.0.0.1:3306/")).toMatch(/private or loopback/);
    expect(egressUrlProblem("http://10.0.0.5/internal")).toMatch(/private or loopback/);
  });

  it("rejects a bracketed IPv6 loopback in a real URL", () => {
    // The end-to-end shape of the bypass: this exact URL was accepted with a 201 by the running
    // server before `unbracket` existed, while every bare-address assertion in this file passed.
    expect(egressUrlProblem("http://[::ffff:127.0.0.1]/hook")).toMatch(/private or loopback/);
    expect(egressUrlProblem("http://[::1]:3306/")).toMatch(/private or loopback/);
    expect(egressUrlProblem("https://[fe80::1]/x")).toMatch(/private or loopback/);
  });

  it("rejects internal-only names, including the cloud metadata hostnames", () => {
    expect(egressUrlProblem("http://localhost:4000/hook")).toMatch(/reachable from the internet/);
    expect(egressUrlProblem("http://metadata.google.internal/")).toMatch(/reachable from the internet/);
    expect(egressUrlProblem("http://db.internal/")).toMatch(/internal-only name/);
    expect(egressUrlProblem("http://printer.local/")).toMatch(/internal-only name/);
  });

  it("accepts an ordinary public https webhook URL", () => {
    expect(egressUrlProblem("https://hooks.example.com/services/abc123")).toBeNull();
  });

  it("permits private targets in development, because a local receiver is how this is tested", () => {
    mockEnv.NODE_ENV = "development";
    expect(egressUrlProblem("http://localhost:4000/hook")).toBeNull();
  });

  it("permits private targets when an on-prem deployment opts in", () => {
    // A self-hosted install genuinely has legitimate LAN webhook targets. The point of the flag
    // is that this is a DELIBERATE choice, not the default.
    mockEnv.ALLOW_PRIVATE_NETWORK_EGRESS = true;
    expect(egressUrlProblem("http://10.0.0.5/internal")).toBeNull();
  });
});

describe("assertPublicEgressTarget — the pre-fetch gate", () => {
  it("refuses a hostname that RESOLVES to a private address", async () => {
    // The whole reason DNS is resolved rather than the hostname being string-checked. This host
    // passes every text test there is; the A record is what makes it an attack.
    mockLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertPublicEgressTarget("https://totally-normal.example.com/hook")).rejects.toThrow(
      /resolves to the private or loopback address 127\.0\.0\.1/
    );
  });

  it("refuses a name resolving to BOTH a public and a private address", async () => {
    // Which one `fetch` connects to is not ours to decide, so "one of them is fine" is not an
    // answer. Every returned address has to be public.
    mockLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 }
    ]);
    await expect(assertPublicEgressTarget("https://split-horizon.example.com/hook")).rejects.toThrow(
      /169\.254\.169\.254/
    );
  });

  it("refuses a hostname that does not resolve at all", async () => {
    // "I could not verify where this points" is not a reason to send the request anyway.
    mockLookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertPublicEgressTarget("https://nope.example.com/hook")).rejects.toThrow(/could not be resolved/);
  });

  it("allows a hostname resolving only to public addresses", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const url = await assertPublicEgressTarget("https://hooks.example.com/services/abc");
    expect(url.hostname).toBe("hooks.example.com");
  });

  it("does not waste a DNS query on an address literal", async () => {
    mockLookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    await assertPublicEgressTarget("https://93.184.216.34/hook");
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("carries the label into the message, so an admin knows WHICH url is wrong", async () => {
    await expect(assertPublicEgressTarget("http://127.0.0.1/x", "The Google Chat webhook URL")).rejects.toThrow(
      /The Google Chat webhook URL/
    );
  });

  it("skips DNS entirely when private egress is allowed", async () => {
    mockEnv.NODE_ENV = "development";
    await assertPublicEgressTarget("http://localhost:4000/hook");
    expect(mockLookup).not.toHaveBeenCalled();
  });
});
