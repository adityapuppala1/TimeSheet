/** 7.0.0 — the 24h sweep of leave documents no request references. Real files in a temp dir. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir = "";
let referenced: string[] = [];
vi.mock("../../src/config/storage-paths.js", () => ({ documentsDirForOrg: () => dir }));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));
vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    leaveRequest: {
      findMany: async ({ where }: { where: { attachmentUrl: { in: string[] } } }) =>
        where.attachmentUrl.in.filter((u) => referenced.includes(u)).map((attachmentUrl) => ({ attachmentUrl }))
    }
  }
}));

const svc = await import("../../src/services/leave-upload-cleanup.service.js");
const NOW = new Date("2026-11-24T12:00:00Z");

function file(name: string, ageHours: number) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "x");
  const t = new Date(NOW.getTime() - ageHours * 3600_000);
  fs.utimesSync(p, t, t);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "leave-sweep-"));
  referenced = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("sweepOrphanLeaveUploads", () => {
  it("removes only old, unreferenced leave files", async () => {
    file("a__leave-emp__orphan__1.pdf", 30);
    file("a__leave-emp__used__2.pdf.gz", 30);
    file("a__leave-emp__fresh__3.pdf", 2);
    file("a__ticket-123__old__4.pdf", 300);
    referenced = [svc.publicUrlFor("org-1", "a__leave-emp__used__2.pdf.gz")];
    expect(await svc.sweepOrphanLeaveUploads(NOW)).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual(["a__leave-emp__fresh__3.pdf", "a__leave-emp__used__2.pdf.gz", "a__ticket-123__old__4.pdf"]);
  });

  it("deleteStoredLeaveUpload refuses anything that is not a leave file in the org dir", async () => {
    file("a__ticket-1__x.pdf", 1);
    await svc.deleteStoredLeaveUpload("org-1/a__ticket-1__x.pdf");
    await svc.deleteStoredLeaveUpload("org-1/../../etc/passwd");
    expect(fs.readdirSync(dir)).toEqual(["a__ticket-1__x.pdf"]);
    file("a__leave-emp__y.pdf", 1);
    await svc.deleteStoredLeaveUpload("org-1/a__leave-emp__y.pdf");
    expect(fs.readdirSync(dir)).toEqual(["a__ticket-1__x.pdf"]);
  });
});
