/**
 * Tests for the log rotation rules.
 *
 * The naming/rollover arithmetic is the part that fails silently: a wrong window boundary means
 * two hours of logs land in yesterday's file, or a day never gets compressed, and nobody notices
 * until they go looking for an incident and the lines aren't where the scheme says they are. So
 * the pure functions are pinned exhaustively across a whole day, and compression/pruning are
 * exercised against real files in a temp directory rather than mocked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-logs-"));

const { compressDay, dayKey, logFileFor, pruneOldDays, windowLabel } = await import("../../src/config/logger.js");

beforeAll(() => {
  fs.mkdirSync(tempRoot, { recursive: true });
});
afterAll(async () => {
  await fsp.rm(tempRoot, { recursive: true, force: true });
});

/** Local-time constructor on purpose — every window boundary in the scheme is local, so a UTC
 *  fixture would silently pass or fail depending on the machine's timezone. */
const at = (year: number, month: number, day: number, hour: number, minute = 0) =>
  new Date(year, month - 1, day, hour, minute, 0, 0);

describe("dayKey", () => {
  it("zero-pads so the name sorts as text", () => {
    expect(dayKey(at(2026, 8, 7, 13))).toBe("2026-08-07");
    expect(dayKey(at(2026, 12, 31, 23, 59))).toBe("2026-12-31");
    expect(dayKey(at(2026, 1, 1, 0))).toBe("2026-01-01");
  });
});

describe("windowLabel", () => {
  it("buckets every hour of the day into the right 4-hour window", () => {
    const expected = [
      ...Array<string>(4).fill("00-04"),
      ...Array<string>(4).fill("04-08"),
      ...Array<string>(4).fill("08-12"),
      ...Array<string>(4).fill("12-16"),
      ...Array<string>(4).fill("16-20"),
      ...Array<string>(4).fill("20-24")
    ];
    for (let hour = 0; hour < 24; hour += 1) {
      expect(windowLabel(at(2026, 8, 7, hour, 30), 4), `hour ${hour}`).toBe(expected[hour]);
    }
  });

  it("puts the last minute of a window in that window, not the next", () => {
    expect(windowLabel(at(2026, 8, 7, 3, 59), 4)).toBe("00-04");
    expect(windowLabel(at(2026, 8, 7, 4, 0), 4)).toBe("04-08");
  });

  it("clamps the final window to 24 for sizes that do not divide the day", () => {
    // 5-hour buckets: 00-05 / 05-10 / 10-15 / 15-20 / 20-24. The short tail is intentional —
    // clamping keeps every filename inside one calendar date.
    expect(windowLabel(at(2026, 8, 7, 21), 5)).toBe("20-24");
    expect(windowLabel(at(2026, 8, 7, 23), 7)).toBe("21-24");
  });

  it("collapses to a single daily file at 24 and an hourly one at 1", () => {
    expect(windowLabel(at(2026, 8, 7, 0), 24)).toBe("00-24");
    expect(windowLabel(at(2026, 8, 7, 23), 24)).toBe("00-24");
    expect(windowLabel(at(2026, 8, 7, 9), 1)).toBe("09-10");
  });
});

describe("logFileFor", () => {
  it("builds <root>/<date>/app-<date>_<window>.log", () => {
    const target = logFileFor(path.join(tempRoot, "L"), at(2026, 8, 7, 2, 15), 4);
    expect(target.day).toBe("2026-08-07");
    expect(target.dayDir).toBe(path.join(tempRoot, "L", "2026-08-07"));
    expect(target.filePath).toBe(path.join(tempRoot, "L", "2026-08-07", "app-2026-08-07_00-04.log"));
  });

  it("changes file within a day and changes directory across midnight", () => {
    const root = path.join(tempRoot, "L");
    const early = logFileFor(root, at(2026, 8, 7, 3, 59), 4);
    const later = logFileFor(root, at(2026, 8, 7, 4, 0), 4);
    const nextDay = logFileFor(root, at(2026, 8, 8, 0, 0), 4);

    expect(early.filePath).not.toBe(later.filePath);
    expect(early.dayDir).toBe(later.dayDir);
    // The rollover signal the writer keys on: the DAY changed, so yesterday can be compressed.
    expect(nextDay.day).not.toBe(later.day);
    expect(nextDay.dayDir).not.toBe(later.dayDir);
  });

  it("keeps the date in the filename as well as the directory", () => {
    // So a file copied out of its directory still says which day it is.
    const target = logFileFor(tempRoot, at(2026, 2, 3, 20), 4);
    expect(path.basename(target.filePath)).toBe("app-2026-02-03_20-24.log");
  });
});

describe("compressDay", () => {
  it("gzips every .log, removes the original, and preserves the bytes", async () => {
    const root = path.join(tempRoot, "compress");
    const dir = path.join(root, "2026-08-06");
    fs.mkdirSync(dir, { recursive: true });
    const body = "2026-08-06 01:02:03.004 INFO  hello\n".repeat(500);
    fs.writeFileSync(path.join(dir, "app-2026-08-06_00-04.log"), body);
    fs.writeFileSync(path.join(dir, "app-2026-08-06_04-08.log"), body);

    expect(await compressDay(root, "2026-08-06")).toBe(2);

    const entries = fs.readdirSync(dir).sort();
    expect(entries).toEqual(["app-2026-08-06_00-04.log.gz", "app-2026-08-06_04-08.log.gz"]);
    const restored = zlib.gunzipSync(fs.readFileSync(path.join(dir, entries[0]))).toString();
    expect(restored).toBe(body);
    // The saving is the whole reason this exists.
    expect(fs.statSync(path.join(dir, entries[0])).size).toBeLessThan(body.length);
  });

  it("leaves already-compressed files and foreign files alone, and never throws on a missing day", async () => {
    const root = path.join(tempRoot, "compress-idempotent");
    const dir = path.join(root, "2026-08-05");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "app-2026-08-05_00-04.log.gz"), zlib.gzipSync("already"));
    fs.writeFileSync(path.join(dir, "notes.txt"), "not ours");

    expect(await compressDay(root, "2026-08-05")).toBe(0);
    expect(fs.readdirSync(dir).sort()).toEqual(["app-2026-08-05_00-04.log.gz", "notes.txt"]);
    // A day that was already pruned, or a root that vanished — reporting zero beats throwing
    // inside a detached rollover nobody is awaiting.
    await expect(compressDay(root, "1999-01-01")).resolves.toBe(0);
  });
});

describe("pruneOldDays", () => {
  it("deletes day-directories past the retention window and keeps the rest", async () => {
    const root = path.join(tempRoot, "prune");
    fs.mkdirSync(root, { recursive: true });

    const dayDir = (offsetDays: number) => {
      const date = new Date();
      date.setDate(date.getDate() - offsetDays);
      const name = dayKey(date);
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, "app.log.gz"), "x");
      return name;
    };

    const today = dayDir(0);
    const recent = dayDir(3);
    const stale = dayDir(40);
    const ancient = dayDir(400);

    const removed = await pruneOldDays(root, 7);
    expect(removed.sort()).toEqual([ancient, stale].sort());
    expect(fs.existsSync(path.join(root, today))).toBe(true);
    expect(fs.existsSync(path.join(root, recent))).toBe(true);
    expect(fs.existsSync(path.join(root, stale))).toBe(false);
  });

  it("never touches anything that is not one of its own YYYY-MM-DD directories", async () => {
    // This function does a recursive delete inside an operator-supplied root. Anything it does
    // not positively recognise must survive, or a mis-set LOG_DIR becomes a data-loss bug.
    const root = path.join(tempRoot, "prune-safety");
    fs.mkdirSync(path.join(root, "archive"), { recursive: true });
    fs.mkdirSync(path.join(root, "2026-8-7"), { recursive: true }); // not zero-padded
    fs.mkdirSync(path.join(root, "20260807"), { recursive: true });
    fs.writeFileSync(path.join(root, "2020-01-01"), "a FILE, not a directory");

    expect(await pruneOldDays(root, 1)).toEqual([]);
    expect(fs.readdirSync(root).sort()).toEqual(["2020-01-01", "2026-8-7", "20260807", "archive"]);
  });

  it("returns empty rather than throwing when the root does not exist", async () => {
    await expect(pruneOldDays(path.join(tempRoot, "never-created"), 7)).resolves.toEqual([]);
  });
});
