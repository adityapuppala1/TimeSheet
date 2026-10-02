/**
 * H1, the save side: the retention policy refuses a snapshot directory outside SNAPSHOT_ROOT, and
 * stores the one it accepts as an absolute path — the deletion-time `mysqldump` writes to the stored
 * value directly, so a relative "retention" must not end up meaning "relative to wherever the API
 * process happened to start".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let stored: Record<string, unknown>;
const control = {
  platformRetentionSettings: {
    findUnique: vi.fn(async () => stored),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      stored = { ...stored, ...data, updatedAt: new Date() };
      return stored;
    })
  },
  platformAuditLog: { create: vi.fn() }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

const { env } = await import("../../src/config/env.js");
const { updateRetentionSettings } = await import("../../src/services/retention.service.js");

let base: string;
const original = env.SNAPSHOT_ROOT;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "ts-retention-root-"));
  env.SNAPSHOT_ROOT = base;
});
afterAll(() => {
  env.SNAPSHOT_ROOT = original;
  fs.rmSync(base, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  stored = { id: "global", enabled: true, feedbackDay: 10, reminderDays: [30, 60, 80, 90], retentionDays: 90, autoDeleteEnabled: true, snapshotDir: null, updatedAt: new Date() };
});

describe("updateRetentionSettings and the snapshot directory", () => {
  it("stores a directory inside the root as an absolute path", async () => {
    const result = await updateRetentionSettings({ snapshotDir: "retention" }, "ops@timesphere.app");
    expect(result.snapshotDir).toBe(path.join(base, "retention"));
  });

  it("refuses a directory outside the root and changes nothing", async () => {
    await expect(updateRetentionSettings({ snapshotDir: os.homedir() }, "ops@timesphere.app")).rejects.toMatchObject({ statusCode: 422 });
    await expect(updateRetentionSettings({ snapshotDir: "../elsewhere" }, "ops@timesphere.app")).rejects.toMatchObject({ statusCode: 422 });
    expect(control.platformRetentionSettings.update).not.toHaveBeenCalled();
  });

  it("still lets an unrelated setting be saved when an old out-of-root value is stored", async () => {
    stored = { ...stored, snapshotDir: "/somewhere/else" };
    await expect(updateRetentionSettings({ feedbackDay: 12 }, "ops@timesphere.app")).resolves.toMatchObject({ feedbackDay: 12 });
  });

  // R1-5. The console's form re-sends every field on every save, the stored directory included —
  // so validating whatever the save NAMES blocked every edit, even pausing the programme, on an
  // install whose directory predates SNAPSHOT_ROOT.
  it("accepts the form re-sending an unchanged out-of-root value alongside another change, and keeps it as stored", async () => {
    stored = { ...stored, snapshotDir: "/somewhere/else" };
    const result = await updateRetentionSettings({ enabled: false, feedbackDay: 10, reminderDays: [30, 60, 80, 90], retentionDays: 90, autoDeleteEnabled: true, snapshotDir: "/somewhere/else" }, "ops@timesphere.app");
    expect(result).toMatchObject({ enabled: false, snapshotDir: "/somewhere/else" });
  });

  it("still refuses CHANGING an out-of-root value to another one outside the root", async () => {
    stored = { ...stored, snapshotDir: "/somewhere/else" };
    await expect(updateRetentionSettings({ snapshotDir: os.homedir() }, "ops@timesphere.app")).rejects.toMatchObject({ statusCode: 422 });
    expect(control.platformRetentionSettings.update).not.toHaveBeenCalled();
  });
});
