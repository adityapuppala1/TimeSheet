/**
 * The downloadable PRD/BRD template. Pins the one property that actually matters: it covers every
 * area the interview asks about, so someone who fills it in has answered the whole interview up
 * front rather than most of it.
 */
import { describe, expect, it } from "vitest";
import { REQUIREMENTS_SECTIONS } from "../../src/services/ai.service.js";
import { renderRequirementsDocTemplate } from "../../src/services/requirements-doc-template.service.js";

describe("renderRequirementsDocTemplate", () => {
  it("emits one heading per interview area, so nothing the interview asks about is missing", () => {
    const template = renderRequirementsDocTemplate();
    const headingCount = (template.match(/^## /gm) ?? []).length;
    expect(headingCount).toBe(REQUIREMENTS_SECTIONS.length);
  });

  it("is long enough to clear the import path's own minimum-readable-text guard", () => {
    // requirements-doc.service.ts refuses anything under 200 chars as "probably a scanned image".
    // A template that couldn't be re-uploaded through this app would be worse than useless.
    expect(renderRequirementsDocTemplate().trim().length).toBeGreaterThan(200);
  });

  it("gives each section a guidance prompt rather than a bare heading", () => {
    const template = renderRequirementsDocTemplate();
    const promptCount = (template.match(/^\[.+\]$/gm) ?? []).length;
    expect(promptCount).toBe(REQUIREMENTS_SECTIONS.length);
  });
});
