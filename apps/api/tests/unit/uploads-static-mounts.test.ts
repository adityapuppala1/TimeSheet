/**
 * Tests the `/uploads` mounts against the real Express app.
 *
 * WHY AGAINST THE APP AND NOT THE HELPERS: what is served here is decided by the ORDER of five
 * middlewares in app.ts (private-subtree guard → signed-grant gate → avatar static → gzip handler
 * → document static), and every unit-level assertion about the helpers underneath can pass while
 * the composition is wrong. Two real regressions are pinned here:
 *
 *  1. `/uploads` was served with NO authentication from the storage root, and the face (biometric)
 *     tree defaults to a directory INSIDE that root — so `/uploads/face/<orgId>/<userId>/<file>`
 *     was readable by anyone who could guess a filename, despite face.service.ts documenting the
 *     exact opposite.
 *  2. The documents tree had no org segment and filenames were `<timestamp>-<original name>`, so
 *     one tenant's attachments were readable from any hostname by an unauthenticated stranger.
 *     Reads now require a signed, expiring, org-bound grant (utils/file-url.ts).
 *
 * The legacy cases matter for the other half of the contract: existing installs have `avatarUrl`
 * and attachment `url` rows in the flat shape with files on disk to match, and they must keep
 * resolving now that new files are written per-org / per-user.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-mounts-"));
process.env.UPLOAD_DIR = tempRoot;

const { app } = await import("../../src/app.js");
const { signFileUrl } = await import("../../src/utils/file-url.js");

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

/** What the API would have put in a JSON response for this file — i.e. exactly what a browser
 *  would then request. Tests go through the real signer so a change to the scheme cannot pass
 *  here while breaking in production. */
const grantFor = (storedUrl: string, orgId: string) => signFileUrl(storedUrl, orgId);

const outsideFile = path.join(path.dirname(tempRoot), `ts-mounts-outside-${process.pid}.txt`);

beforeAll(() => {
  fs.mkdirSync(path.join(tempRoot, "avatars", "user-1"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, "face", "org-1", "user-1"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, ORG_A), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, ORG_B), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "legacy-attachment.pdf"), "PDF BYTES");
  fs.writeFileSync(path.join(tempRoot, ORG_A, "org-a-secret.pdf"), "ORG A BYTES");
  fs.writeFileSync(path.join(tempRoot, ORG_B, "org-b-secret.pdf"), "ORG B BYTES");
  fs.writeFileSync(path.join(tempRoot, "avatars", "legacy-flat.png"), "PNG FLAT");
  fs.writeFileSync(path.join(tempRoot, "avatars", "user-1", "avatar-user-1-123.png"), "PNG NESTED");
  fs.writeFileSync(path.join(tempRoot, "face", "org-1", "user-1", "reference-1.jpg"), "BIOMETRIC");
  fs.writeFileSync(outsideFile, "OUTSIDE THE ROOT");
});
afterAll(async () => {
  await fsp.rm(tempRoot, { recursive: true, force: true });
  await fsp.rm(outsideFile, { force: true });
});

describe("/uploads — what it serves to a holder of a valid grant", () => {
  it("serves an org-segmented document and forces it to download", async () => {
    const res = await request(app).get(grantFor(`/uploads/${ORG_A}/org-a-secret.pdf`, ORG_A));
    expect(res.status).toBe(200);
    // `res.body`, not `res.text`: supertest only decodes a body it has a text parser for, and
    // these are served as a download with a binary content type.
    expect(res.body.toString()).toBe("ORG A BYTES");
    // Defense-in-depth on top of the extension allow-list: an allowed-but-unexpected file type
    // must never execute as script in the API's origin just because someone opened its URL.
    expect(res.headers["content-disposition"]).toBe("attachment");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("still serves a LEGACY flat document — nothing on disk was moved", async () => {
    const res = await request(app).get(grantFor("/uploads/legacy-attachment.pdf", ORG_A));
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("PDF BYTES");
  });

  it("serves avatars in BOTH the legacy flat and the new per-user layout", async () => {
    expect((await request(app).get(grantFor("/uploads/avatars/legacy-flat.png", ORG_A))).status).toBe(200);
    expect((await request(app).get(grantFor("/uploads/avatars/user-1/avatar-user-1-123.png", ORG_A))).status).toBe(200);
  });

  it("keeps avatars inline-renderable rather than forcing a download", async () => {
    // They are re-encoded through sharp on upload and are always real images, so <img> must work.
    const res = await request(app).get(grantFor("/uploads/avatars/legacy-flat.png", ORG_A));
    expect(res.headers["content-disposition"]).toBeUndefined();
  });

  it("emits a STABLE url within an expiry bucket so the browser cache still works", async () => {
    // Avatars are re-signed on every response that mentions them; a signature that changed per
    // response would make every <img> a cache miss.
    expect(grantFor("/uploads/avatars/legacy-flat.png", ORG_A)).toBe(grantFor("/uploads/avatars/legacy-flat.png", ORG_A));
  });
});

describe("/uploads — what it must NOT serve", () => {
  it("refuses an UNSIGNED request for a document that exists", async () => {
    // The finding: this returned 200 to anyone on the internet who could guess the filename.
    expect((await request(app).get(`/uploads/${ORG_A}/org-a-secret.pdf`)).status).toBe(403);
    expect((await request(app).get("/uploads/legacy-attachment.pdf")).status).toBe(403);
  });

  it("refuses one tenant's grant used against another tenant's document", async () => {
    // Both halves matter: the signature is over (org, path), so re-pointing it fails the HMAC,
    // and even a valid grant for org B cannot name a path under org A.
    const forgedPath = grantFor(`/uploads/${ORG_A}/org-a-secret.pdf`, ORG_A).replace(`o=${ORG_A}`, `o=${ORG_B}`);
    expect((await request(app).get(forgedPath)).status).toBe(403);

    const orgBGrant = grantFor(`/uploads/${ORG_B}/org-b-secret.pdf`, ORG_B);
    const swappedPath = orgBGrant.replace(`/${ORG_B}/org-b-secret.pdf`, `/${ORG_A}/org-a-secret.pdf`);
    expect((await request(app).get(swappedPath)).status).toBe(403);
  });

  it("refuses a tampered signature and an expired one", async () => {
    const signed = grantFor("/uploads/legacy-attachment.pdf", ORG_A);
    expect((await request(app).get(`${signed}x`)).status).toBe(403);
    expect((await request(app).get(signed.replace(/e=\d+/, "e=1"))).status).toBe(403);
  });

  it("refuses biometric imagery even though it sits inside the served root", async () => {
    expect((await request(app).get("/uploads/face/org-1/user-1/reference-1.jpg")).status).toBe(404);
    // 404 rather than 403 even WITH a valid grant: the correct answer for the face tree is
    // "there is nothing here", not "get a better link".
    expect((await request(app).get(grantFor("/uploads/face/org-1/user-1/reference-1.jpg", ORG_A))).status).toBe(404);
  });

  it("refuses a percent-encoded route to the same file", async () => {
    // %66 is "f" — the guard decodes before resolving, so an encoded prefix is not a way past it.
    expect((await request(app).get("/uploads/%66ace/org-1/user-1/reference-1.jpg")).status).toBe(404);
    expect((await request(app).get("/uploads/face%2Forg-1%2Fuser-1%2Freference-1.jpg")).status).toBe(404);
  });

  it("refuses traversal out of the storage root", async () => {
    // The unencoded form never reaches `/uploads` at all — the client collapses it before the
    // request is sent, so it lands on the app's 404. The encoded form does reach the gate.
    expect((await request(app).get(`/uploads/../${path.basename(outsideFile)}`)).status).toBe(404);
    expect((await request(app).get("/uploads/..%2F..%2F..%2Fetc%2Fpasswd")).status).toBe(403);
    // And traversal does not become reachable just because the caller can sign what they ask for:
    // past the gate, containment (resolveStoredFile's key normalisation and serve-static's own
    // refusal of an encoded separator) still answers "no such file".
    expect((await request(app).get(grantFor("/uploads/..%2F..%2F..%2Fetc%2Fpasswd", ORG_A))).status).toBe(404);
  });

  it("404s a file that isn't there rather than erroring", async () => {
    expect((await request(app).get(grantFor("/uploads/nothing-here.txt", ORG_A))).status).toBe(404);
  });
});
