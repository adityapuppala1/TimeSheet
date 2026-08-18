/**
 * The reconciliation that keeps the email registry honest.
 *
 * Three separate lists have to agree about what an email template is, and nothing checked that they
 * did. They had already drifted in two directions at once:
 *
 *   - `digest.bug_pattern` and `ticket.stale_nudge` were being SENT from code and were missing from
 *     `TEMPLATE_VARIABLES`, so the editor never listed them, no administrator could change a word,
 *     and their delivery analytics fell into the unmapped bucket.
 *   - Every key lacked a shipped DEFAULT, so the editor rendered a three-line stub in place of the
 *     real email — and saving from that screen replaced a carefully built template with the stub.
 *
 * Both are the kind of gap that is invisible from any single file. So this walks the actual source
 * for every `templateKey:` dispatched anywhere and holds the registry to it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const { TEMPLATE_KEYS, TEMPLATE_VARIABLES, TEMPLATE_DESCRIPTIONS, TEMPLATE_DEFAULTS, sampleVariables, applyVars } = await import(
  "../../src/services/template-store.service.js"
);

/** Every `templateKey: "..."` in the API source — the ground truth for what this product sends. */
function dispatchedKeys(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        // `generated/` is Prisma's output — megabytes of client code with no templates in it.
        if (entry !== "generated" && entry !== "node_modules") walk(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      for (const match of readFileSync(full, "utf8").matchAll(/templateKey:\s*"([a-z._]+)"/g)) found.add(match[1]);
    }
  };
  walk(join(process.cwd(), "src"));
  return found;
}

describe("every template this product sends is one an administrator can edit", () => {
  it("has no key dispatched in code that the editor does not list", () => {
    const missing = [...dispatchedKeys()].filter((key) => !TEMPLATE_KEYS.includes(key)).sort();
    // A key here means an email goes out that nobody can change, preview, or see analytics for by
    // card. Add it to TEMPLATE_VARIABLES, TEMPLATE_DESCRIPTIONS, sampleVariables and TEMPLATE_DEFAULTS.
    expect(missing).toEqual([]);
  });

  it("finds at least the templates we know are dispatched, so the scan itself cannot silently pass", () => {
    // A regex that matched nothing would make the assertion above vacuously true forever.
    const dispatched = dispatchedKeys();
    expect(dispatched.size).toBeGreaterThan(20);
    expect(dispatched).toContain("timesheet.submitted");
    expect(dispatched).toContain("digest.bug_pattern");
  });
});

describe("every listed template can be previewed and edited", () => {
  it("has a description, so the editor's list is readable", () => {
    expect(TEMPLATE_KEYS.filter((k) => !TEMPLATE_DESCRIPTIONS[k]?.trim())).toEqual([]);
  });

  it("has declared variables", () => {
    expect(TEMPLATE_KEYS.filter((k) => (TEMPLATE_VARIABLES[k] ?? []).length === 0)).toEqual([]);
  });

  it("has a shipped default body and subject", () => {
    // The absence of these is what made the editor show a stub for every un-customised template.
    expect(TEMPLATE_KEYS.filter((k) => !TEMPLATE_DEFAULTS[k]?.html?.trim())).toEqual([]);
    expect(TEMPLATE_KEYS.filter((k) => !TEMPLATE_DEFAULTS[k]?.subject?.trim())).toEqual([]);
  });

  it("ships a default body that is the real email, not a fragment", () => {
    for (const key of TEMPLATE_KEYS) {
      const html = TEMPLATE_DEFAULTS[key].html;
      // The shell every real template renders through. A body without it is a stub or a raw string.
      expect(html, key).toContain("<table");
      expect(html.length, key).toBeGreaterThan(400);
    }
  });

  it("has sample values for every variable it declares, so a preview has nothing left unresolved", () => {
    const gaps: string[] = [];
    for (const key of TEMPLATE_KEYS) {
      const samples = sampleVariables(key);
      for (const variable of TEMPLATE_VARIABLES[key] ?? []) {
        // `appUrl` is supplied by the renderer rather than by the sample set.
        if (variable !== "appUrl" && samples[variable] === undefined) gaps.push(`${key}.${variable}`);
      }
    }
    expect(gaps).toEqual([]);
  });
});

describe("a preview leaves no placeholder behind", () => {
  it("resolves every {{token}} in the shipped body from the sample values", () => {
    const unresolved: string[] = [];
    for (const key of TEMPLATE_KEYS) {
      const rendered = applyVars(TEMPLATE_DEFAULTS[key].html, { ...sampleVariables(key), appUrl: "https://timesphere.local" });
      // A leftover `{{token}}` in a preview is a variable the registry forgot to declare — the reader
      // sees braces where a value should be, which is exactly the "preview is not showing the details"
      // complaint this whole pass came from.
      for (const match of rendered.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) unresolved.push(`${key}.${match[1]}`);
    }
    expect([...new Set(unresolved)]).toEqual([]);
  });
});
