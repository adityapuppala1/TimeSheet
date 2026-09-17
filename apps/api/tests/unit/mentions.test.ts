/** V12 8.1 — mentions are the ids the editor wrote, read back after sanitising; nothing else. */
import { describe, expect, it } from "vitest";
import { extractMentionIds } from "../../src/services/mentions.service.js";
import { sanitizeRichText } from "../../src/utils/sanitize.js";

const ANA = "11111111-1111-4111-8111-111111111111";
const BO = "22222222-2222-4222-8222-222222222222";

describe("extractMentionIds", () => {
  it("returns unique ids in order and ignores malformed ones", () => {
    const html = `<p>Hi <span data-mention-id="${ANA}" data-mention-label="Ana">@Ana</span> and <span data-mention-id="${BO}">@Bo</span>, again <span data-mention-id="${ANA}">@Ana</span> and <span data-mention-id="not-an-id">@X</span></p>`;
    expect(extractMentionIds(html)).toEqual([ANA, BO]);
  });
  it("is empty for no mentions, empty and null bodies", () => {
    expect(extractMentionIds("<p>plain</p>")).toEqual([]);
    expect(extractMentionIds("")).toEqual([]);
    expect(extractMentionIds(null)).toEqual([]);
  });
  it("survives the sanitiser: the two mention attributes are kept, anything else on a span is dropped", () => {
    const clean = sanitizeRichText(`<p><span data-mention-id="${ANA}" data-mention-label="Ana" onclick="x()" class="evil">@Ana</span></p>`);
    expect(clean).toContain(`data-mention-id="${ANA}"`);
    expect(clean).toContain('data-mention-label="Ana"');
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("class=");
    expect(extractMentionIds(clean)).toEqual([ANA]);
  });
});
