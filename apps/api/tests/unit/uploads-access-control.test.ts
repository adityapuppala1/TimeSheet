/**
 * The access-control half of the `/uploads` lockdown, end to end: the upload pipeline writes under
 * an org, the response signer turns a stored path into a capability, and the app serves it only to
 * a holder of that capability.
 *
 * WHY THESE PARTICULAR CASES: the finding being closed is that a stranger could read another
 * tenant's ticket attachment by guessing `<timestamp>-<filename>` against a flat, shared,
 * unauthenticated directory. Proving that is fixed needs all four of: files land per-org, names
 * carry real entropy, an unsigned read fails, and — the constraint that shaped the design — the
 * UNAUTHENTICATED guest reviewer in approval.controller.ts still gets a link that works.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-access-"));
process.env.UPLOAD_DIR = tempRoot;

const { app } = await import("../../src/app.js");
const { signFileUrl, signFileUrlsDeep, verifyFileGrant } = await import("../../src/utils/file-url.js");
const { processUpload, resolveStoredFile } = await import("../../src/services/attachment-storage.service.js");
const { tenantContext } = await import("../../src/config/tenant-context.js");

const ORG_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

/** `prisma` is never touched by processUpload, so a context with only the org populated is enough
 *  — and is honest about which part of the context this code actually depends on. */
function asOrg<T>(orgId: string, run: () => T): T {
  return tenantContext.run({ orgId, orgSlug: orgId.slice(0, 8), client: null as never }, run);
}

const fileOf = (name: string, body: string): Express.Multer.File =>
  ({ originalname: name, buffer: Buffer.from(body), mimetype: "application/pdf", size: body.length }) as Express.Multer.File;

beforeAll(() => fs.mkdirSync(tempRoot, { recursive: true }));
afterAll(() => fsp.rm(tempRoot, { recursive: true, force: true }));

describe("uploads land under the owning organization", () => {
  it("writes to <documents>/<orgId>/ and names the file with real entropy", async () => {
    const processed = await asOrg(ORG_A, () =>
      processUpload(fileOf("Q3 Invoice.pdf", "INVOICE A"), { userName: "Ada", entityType: "ticket", entityId: "abcdef1234567890" })
    );

    expect(processed.storageKey.startsWith(`${ORG_A}/`)).toBe(true);
    expect(processed.url.startsWith(`/uploads/${ORG_A}/`)).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, processed.storageKey))).toBe(true);
    // 128 bits of crypto.randomBytes. The old tail was 24 bits behind a guessable prefix.
    expect(processed.storageKey).toMatch(/__[0-9a-f]{32}\.pdf$/);
    // The regression that made the tree enumerable: a millisecond clock plus the user's own
    // filename, which anyone who saw the attachment in a ticket could reconstruct.
    expect(processed.storageKey).not.toMatch(/\/\d{13}-/);
  });

  it("refuses to write at all when no organization is in context", async () => {
    // A flat write with no owning org is the exact condition this change removes, so the pipeline
    // fails loudly rather than falling back to it.
    await expect(
      processUpload(fileOf("orphan.pdf", "NO ORG"), { userName: "Ada", entityType: "ticket", entityId: "abcdef1234567890" })
    ).rejects.toThrow(/No tenant context/);
  });
});

describe("reading a document", () => {
  it("serves it to a signed grant and refuses the same URL unsigned", async () => {
    const processed = await asOrg(ORG_A, () =>
      processUpload(fileOf("brief.pdf", "BRIEF BYTES"), { userName: "Ada", entityType: "ticket", entityId: "abcdef1234567890" })
    );

    expect((await request(app).get(processed.url)).status).toBe(403);

    const signed = await request(app).get(signFileUrl(processed.url, ORG_A));
    expect(signed.status).toBe(200);
    expect(signed.body.toString()).toBe("BRIEF BYTES");
  });

  it("does not let one tenant's grant reach another tenant's file", async () => {
    const theirs = await asOrg(ORG_B, () =>
      processUpload(fileOf("secret.pdf", "ORG B SECRET"), { userName: "Bob", entityType: "ticket", entityId: "beefbeef12345678" })
    );

    // Signing org B's path as org A is what an attacker with a session in org A can actually do:
    // the HMAC covers the org, so the server recomputes a different digest and refuses.
    expect((await request(app).get(signFileUrl(theirs.url, ORG_A))).status).toBe(403);
    // And the honest grant still works, so the refusal above is about tenancy, not a broken path.
    expect((await request(app).get(signFileUrl(theirs.url, ORG_B))).status).toBe(200);
  });

  it("still resolves a path stored before documents were org-segmented", async () => {
    // Written flat, exactly as an install upgraded from an earlier version has it on disk.
    fs.writeFileSync(path.join(tempRoot, "1754500000000-old-report.pdf"), "LEGACY BYTES");

    const resolved = await resolveStoredFile("1754500000000-old-report.pdf");
    expect(resolved).not.toBeNull();
    expect(resolved!.gunzip).toBe(false);

    const res = await request(app).get(signFileUrl("/uploads/1754500000000-old-report.pdf", ORG_A));
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("LEGACY BYTES");
  });
});

describe("the guest reviewer path", () => {
  it("hands an unauthenticated reviewer a link that works", async () => {
    const processed = await asOrg(ORG_A, () =>
      processUpload(fileOf("deliverable.pdf", "FOR REVIEW"), { userName: "Ada", entityType: "ticket", entityId: "abcdef1234567890" })
    );

    // The exact shape controllers/approval.controller.ts's public route returns to a guest whose
    // only credential is the token in their emailed link. app.ts signs it on the way out.
    const payload = signFileUrlsDeep(
      {
        title: "Sign off the Q3 brief",
        item: { reference: "TS-14", attachments: [{ id: "att-1", fileName: processed.fileName, url: processed.url }] }
      },
      ORG_A
    );

    const link = payload.item.attachments[0].url;
    expect(link).not.toBe(processed.url);

    // No cookie, no Authorization header — the capability is entirely in the URL, which is the
    // whole reason this design is signed URLs rather than requireAuth on /uploads.
    const res = await request(app).get(link);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("FOR REVIEW");
  });
});

describe("signFileUrlsDeep", () => {
  it("signs every /uploads string it finds and leaves everything else alone", () => {
    const body = { name: "Ada", avatarUrl: "/uploads/avatars/u1/a.png", link: "https://example.com/uploads/x", count: 3 };
    const signed = signFileUrlsDeep(body, ORG_A);

    expect(signed.avatarUrl).toMatch(/^\/uploads\/avatars\/u1\/a\.png\?o=/);
    expect(signed.link).toBe(body.link);
    expect(signed.count).toBe(3);
  });

  it("never mutates the body it was given", () => {
    // Some responses are built from cached objects; stamping an expiring signature onto one would
    // serve a dead link forever.
    const attachment = { url: "/uploads/a.pdf" };
    const body = { rows: [attachment] };
    signFileUrlsDeep(body, ORG_A);
    expect(attachment.url).toBe("/uploads/a.pdf");
  });

  it("returns the SAME reference when nothing needed signing", () => {
    // Copy-on-write: the overwhelming majority of responses mention no file at all and must not
    // pay for a clone of the whole payload.
    const body = { rows: [{ id: 1 }, { id: 2 }] };
    expect(signFileUrlsDeep(body, ORG_A)).toBe(body);
  });

  it("passes class instances through untouched", () => {
    // Rebuilding a Date (or a Prisma Decimal) as a plain object silently changes how it serializes.
    const when = new Date("2026-08-07T00:00:00.000Z");
    const signed = signFileUrlsDeep({ when, url: "/uploads/a.pdf" }, ORG_A);
    expect(signed.when).toBe(when);
  });
});

describe("verifyFileGrant", () => {
  it("rejects an expired grant, a wrong org, and a truncated signature", () => {
    const url = signFileUrl("/uploads/a.pdf", ORG_A);
    const query = Object.fromEntries(new URLSearchParams(url.split("?")[1]));

    expect(verifyFileGrant("a.pdf", query)).toEqual({ orgId: ORG_A });
    expect(verifyFileGrant("a.pdf", query, Date.now() + 40 * 24 * 60 * 60 * 1000)).toBeNull();
    expect(verifyFileGrant("a.pdf", { ...query, o: ORG_B })).toBeNull();
    expect(verifyFileGrant("b.pdf", query)).toBeNull();
    // A shorter signature must return null, not throw out of timingSafeEqual's length check.
    expect(verifyFileGrant("a.pdf", { ...query, s: String(query.s).slice(0, 8) })).toBeNull();
  });
});
