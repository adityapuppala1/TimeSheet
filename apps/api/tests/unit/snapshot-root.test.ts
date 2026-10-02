/**
 * H1 — the snapshot directory could point anywhere, so any file the API process can read could be
 * downloaded through the console.
 *
 * `PlatformRetentionSettings.snapshotDir` was a free-text path one OPERATOR could set alone, and
 * `resolveFile` matched ANY entry in it. Point it at the uploads volume, or at the directory holding
 * a non-container install's `.env`, and `GET /backups/:id/download` streamed whatever was there.
 *
 * Now:
 *  - every snapshot directory must resolve INSIDE SNAPSHOT_ROOT — `..`, an absolute path elsewhere,
 *    and a symlink (or Windows junction) that leads out are all refused, by realpath, not by string;
 *  - the API only ever serves names that match the `<slug>-<timestamp>.sql` shape the snapshot
 *    writer produces, and only regular files that really live in that directory.
 *
 * Real files in a temporary directory: the property is about what the filesystem resolves to.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let snapshotDir: string | null = null;
vi.mock("../../src/services/retention.service.js", () => ({ getRetentionSettings: vi.fn(async () => ({ snapshotDir })) }));
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: { organization: { findMany: vi.fn().mockResolvedValue([]) } } }));
vi.mock("../../src/services/platform-audit.service.js", () => ({ platformAudit: vi.fn() }));
vi.mock("../../src/services/company-domain-claims.service.js", () => ({ reclaimAfterRestore: vi.fn() }));

const { resolveSnapshotDir } = await import("../../src/services/snapshot-root.js");
const { snapshotPath, deleteSnapshot } = await import("../../src/services/platform-backup.service.js");

let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "ts-snapshot-root-"));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "retention"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secrets.env"), "ENCRYPTION_KEY=do-not-leak\n");
  fs.writeFileSync(path.join(root, "retention", "acme-2026-10-02T10-00-00-000Z.sql"), "-- dump\n");
  fs.writeFileSync(path.join(root, "retention", "secrets.env"), "ENCRYPTION_KEY=do-not-leak\n");
  // A directory link inside the root that leads out of it. A junction, because creating one needs no
  // elevated rights on Windows; on Linux and macOS the type argument is ignored and it is a symlink.
  fs.symlinkSync(outside, path.join(root, "escape"), "junction");
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("resolveSnapshotDir", () => {
  it("accepts a directory inside the root, absolute or relative to it, and returns the absolute path", async () => {
    expect(await resolveSnapshotDir(path.join(root, "retention"), root)).toBe(path.join(root, "retention"));
    expect(await resolveSnapshotDir("retention", root)).toBe(path.join(root, "retention"));
    // Not created yet is fine — the first snapshot creates it.
    expect(await resolveSnapshotDir("later/one", root)).toBe(path.join(root, "later", "one"));
  });

  it("refuses `..`, wherever it is", async () => {
    await expect(resolveSnapshotDir("../outside", root)).rejects.toMatchObject({ statusCode: 422 });
    await expect(resolveSnapshotDir(path.join(root, "retention", "..", "..", "outside"), root)).rejects.toMatchObject({ statusCode: 422 });
  });

  it("refuses an absolute path outside the root", async () => {
    await expect(resolveSnapshotDir(outside, root)).rejects.toMatchObject({ statusCode: 422 });
    await expect(resolveSnapshotDir(path.parse(root).root, root)).rejects.toMatchObject({ statusCode: 422 });
  });

  it("refuses a link inside the root that leads out of it — checked by realpath, not by string", async () => {
    await expect(resolveSnapshotDir("escape", root)).rejects.toMatchObject({ statusCode: 422 });
    await expect(resolveSnapshotDir("escape/deeper", root)).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("serving a snapshot", () => {
  const original = process.env.SNAPSHOT_ROOT;
  beforeEach(async () => {
    const { env } = await import("../../src/config/env.js");
    env.SNAPSHOT_ROOT = root;
    snapshotDir = path.join(root, "retention");
  });
  afterAll(async () => {
    const { env } = await import("../../src/config/env.js");
    env.SNAPSHOT_ROOT = original ?? "";
  });

  it("serves a file with the snapshot writer's name shape", async () => {
    const { full } = await snapshotPath("acme-2026-10-02T10-00-00-000Z.sql");
    expect(full).toBe(path.join(root, "retention", "acme-2026-10-02T10-00-00-000Z.sql"));
  });

  it("refuses any other file in the directory, even one that is really there", async () => {
    await expect(snapshotPath("secrets.env")).rejects.toMatchObject({ statusCode: 404 });
    await expect(deleteSnapshot("secrets.env", "ops@timesphere.app")).rejects.toMatchObject({ statusCode: 404 });
    expect(fs.existsSync(path.join(root, "retention", "secrets.env"))).toBe(true);
  });

  it("refuses to serve anything when the stored directory is outside the root", async () => {
    // A value saved before this release, or a root that has since moved.
    snapshotDir = outside;
    fs.writeFileSync(path.join(outside, "acme-2026-10-02T10-00-00-000Z.sql"), "-- not ours\n");
    await expect(snapshotPath("acme-2026-10-02T10-00-00-000Z.sql")).rejects.toMatchObject({ statusCode: 409 });
  });
});
