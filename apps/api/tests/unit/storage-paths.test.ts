/**
 * Tests for the storage path layer.
 *
 * These cover exactly the two things that fail SILENTLY in production if they're wrong: the
 * containment check that decides whether a caller-supplied name may address a file (get it wrong
 * and `/uploads/../../../etc/passwd` is served, with no error anywhere), and the directory
 * validator the admin UI trusts to say "this path will work" (get it wrong and uploads start
 * failing at 3am with an EPERM nobody was watching for).
 *
 * The layout defaults are asserted too, because backward compatibility is the whole contract:
 * existing installs have files on disk and rows in the database pointing at today's paths.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-storage-"));
// Set BEFORE the import: config/env.ts parses process.env at module load and storage-paths.ts
// resolves its four directories once, at load, from that.
process.env.UPLOAD_DIR = tempRoot;

const {
  avatarsDir,
  describeStorageLayout,
  documentReadDirs,
  documentsDir,
  faceDir,
  isInsideNonPublicSubtree,
  probeDirectory,
  resolveWithin,
  storageRoot,
  validateDirectory
} = await import("../../src/config/storage-paths.js");

beforeAll(() => {
  fs.mkdirSync(tempRoot, { recursive: true });
});
afterAll(async () => {
  await fsp.rm(tempRoot, { recursive: true, force: true });
});

describe("default layout (backward compatibility)", () => {
  it("reproduces today's paths when only UPLOAD_DIR is set", () => {
    // The promise made to every existing install: set nothing new, nothing moves.
    expect(storageRoot()).toBe(path.resolve(tempRoot));
    expect(documentsDir()).toBe(path.resolve(tempRoot));
    expect(avatarsDir()).toBe(path.join(path.resolve(tempRoot), "avatars"));
    expect(faceDir()).toBe(path.join(path.resolve(tempRoot), "face"));
  });

  it("has no legacy fallback directory while documents live in the root", () => {
    expect(documentReadDirs()).toEqual([path.resolve(tempRoot)]);
    expect(describeStorageLayout().documentFallbacks).toEqual([]);
  });

  it("reports every subtree as absolute in the admin layout", () => {
    const layout = describeStorageLayout();
    for (const probe of [layout.root, layout.documents, layout.avatars, layout.face]) {
      expect(path.isAbsolute(probe.path)).toBe(true);
    }
    expect(layout.configuredBy.root).toBe("UPLOAD_DIR");
    expect(layout.configuredBy.documents).toBeNull();
  });
});

describe("resolveWithin — containment", () => {
  const base = path.join(path.resolve(tempRoot), "docs");

  it("accepts a plain name and a nested relative path", () => {
    expect(resolveWithin(base, "report.pdf")).toBe(path.join(base, "report.pdf"));
    expect(resolveWithin(base, "org-1/user-2/avatar.png")).toBe(path.join(base, "org-1", "user-2", "avatar.png"));
  });

  it("refuses every shape of escape", () => {
    for (const attempt of [
      "../secret.txt",
      "../../etc/passwd",
      "a/../../b",
      "a/b/../../../c",
      "./../../x",
      // Already-decoded traversal — the caller decodes before asking us, so this is the shape
      // that actually arrives from a URL like /uploads/%2e%2e%2f%2e%2e%2fetc%2fpasswd.
      "../../../../etc/passwd"
    ]) {
      expect(resolveWithin(base, attempt), attempt).toBeNull();
    }
  });

  it("refuses an absolute path, which would otherwise ignore the base entirely", () => {
    // path.join would happily produce base+absolute nonsense; path.resolve DISCARDS the base when
    // the second argument is absolute, which is precisely why the relative-path check exists.
    expect(resolveWithin(base, "/etc/passwd")).toBeNull();
    expect(resolveWithin(base, "C:\\Windows\\System32\\drivers\\etc\\hosts")).toBeNull();
  });

  it("refuses empty input, the base itself, and NUL truncation", () => {
    expect(resolveWithin(base, "")).toBeNull();
    expect(resolveWithin(base, ".")).toBeNull();
    expect(resolveWithin(base, "ok.txt\0.png")).toBeNull();
  });
});

describe("isInsideNonPublicSubtree", () => {
  it("claims the face tree and anything under it", () => {
    expect(isInsideNonPublicSubtree(faceDir())).toBe(true);
    expect(isInsideNonPublicSubtree(path.join(faceDir(), "org-1", "user-2", "reference-1.jpg"))).toBe(true);
  });

  it("leaves documents and avatars alone", () => {
    expect(isInsideNonPublicSubtree(path.join(documentsDir(), "report.pdf"))).toBe(false);
    expect(isInsideNonPublicSubtree(path.join(avatarsDir(), "u1", "avatar.png"))).toBe(false);
    // A sibling whose name merely starts with the same characters must not be captured — the
    // classic prefix-matching bug that a string startsWith() check would have.
    expect(isInsideNonPublicSubtree(`${faceDir()}-archive/x.jpg`)).toBe(false);
  });
});

describe("validateDirectory", () => {
  it("accepts an existing, writable, absolute directory", () => {
    const result = validateDirectory(tempRoot);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(path.resolve(tempRoot));
  });

  it("rejects a relative path and explains why", () => {
    const result = validateDirectory("uploads");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/absolute/i);
  });

  it("rejects traversal even when the resulting directory exists", () => {
    // Built by string concatenation, not path.join — join normalises the climb away, and the
    // input here comes from a text box, where it arrives exactly as typed.
    fs.mkdirSync(path.join(tempRoot, "sub"), { recursive: true });
    const withClimb = `${path.resolve(tempRoot)}${path.sep}sub${path.sep}..`;
    const result = validateDirectory(withClimb);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("..");
  });

  it("rejects empty, whitespace-only, non-string and NUL-bearing input", () => {
    for (const bad of ["", "   ", "\t\n", null, undefined, 42, {}]) {
      expect(validateDirectory(bad as unknown).ok, String(bad)).toBe(false);
    }
    expect(validateDirectory(`${path.resolve(tempRoot)}\0/etc`).ok).toBe(false);
  });

  it("rejects a path that does not exist rather than creating it", () => {
    const missing = path.join(path.resolve(tempRoot), "definitely-not-created-by-this-test");
    const result = validateDirectory(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/does not exist/i);
    // The point: validating must not have side effects on the filesystem.
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("rejects an existing FILE masquerading as a directory", () => {
    const file = path.join(tempRoot, "not-a-directory.txt");
    fs.writeFileSync(file, "x");
    const result = validateDirectory(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not a directory/i);
  });

  it("leaves no probe file behind after a successful check", () => {
    const probeDir = path.join(tempRoot, "probe-cleanup");
    fs.mkdirSync(probeDir, { recursive: true });
    expect(validateDirectory(probeDir).ok).toBe(true);
    expect(fs.readdirSync(probeDir)).toEqual([]);
  });
});

describe("probeDirectory", () => {
  it("reports a missing directory without throwing", () => {
    const probe = probeDirectory(path.join(path.resolve(tempRoot), "nope"));
    expect(probe.exists).toBe(false);
    expect(probe.writable).toBe(false);
    expect(probe.problem).toBeTruthy();
  });

  it("reports a healthy directory with no problem", () => {
    const probe = probeDirectory(tempRoot);
    expect(probe.exists).toBe(true);
    expect(probe.writable).toBe(true);
    expect(probe.problem).toBeNull();
  });
});
