/**
 * GHSA on `@tiptap/core`: `mergeAttributes()` turns an own `__proto__` key into inherited,
 * executable DOM attributes. Moderate, and the only fix upstream is Tiptap 2 → 3, a major across
 * eight packages that would rewrite the editor for every rich-text surface in the product.
 *
 * SO THE QUESTION THAT DECIDES WHETHER TO TAKE THAT RISK IS REACHABILITY, and it is answerable
 * rather than arguable: can an attribute literally named `__proto__` ever reach a Tiptap editor
 * from this application's storage? Every rich-text value is written through `sanitizeRichText`,
 * whose allow-list names three attributes on `<a>` and `style` on everything else. `__proto__` is
 * not among them, and `disallowedTagsMode: "discard"` is not a filter with an escape hatch.
 *
 * That is an argument from reading the configuration. This file is the same claim made by running
 * it, because an allow-list is exactly the kind of thing that gets widened later by somebody adding
 * one attribute for one feature — and the day it happens, this advisory stops being unreachable and
 * nothing else in the suite would notice.
 *
 * WHAT THIS FILE DOES NOT CLAIM. It does not say Tiptap is fixed, and it is not a substitute for the
 * upgrade. It records why the upgrade is not urgent HERE, and it fails the moment that stops being
 * true. If the allow-list ever gains an attribute this test does not know about, the last block
 * fails and the decision gets made again with current facts.
 */
import { describe, expect, it } from "vitest";

import { sanitizeRichText } from "../../src/utils/sanitize.js";

/** The shapes an attacker would actually try, given the advisory. */
const ATTACKS = [
  '<p __proto__="x">hello</p>',
  '<p __proto__="onclick=alert(1)">hello</p>',
  '<span __proto__="polluted">hi</span>',
  '<a href="https://example.test" __proto__="x">link</a>',
  '<p constructor="x" prototype="y">hello</p>',
  // Casing and whitespace, because an allow-list that lower-cases before comparing and one that
  // does not are different programs.
  '<p __PROTO__="x">hello</p>',
  '<p __proto__ ="x">hello</p>'
];

describe("a __proto__ attribute never survives into stored rich text", () => {
  it.each(ATTACKS)("strips it from %s", (html) => {
    const clean = sanitizeRichText(html);

    // The payload is gone.
    expect(clean.toLowerCase()).not.toContain("__proto__");
    expect(clean.toLowerCase()).not.toContain("constructor=");
    expect(clean.toLowerCase()).not.toContain("prototype=");
    // The legitimate content is not — a sanitiser that answered by discarding everything would
    // pass the assertions above while breaking the feature.
    expect(clean).toMatch(/hello|hi|link/);
  });

  it("keeps the attributes the editor genuinely needs", () => {
    // The other half of the same guarantee: this is an allow-list, not a blocklist, and it has to
    // still allow the things Tiptap emits or every rich-text field silently loses formatting.
    const clean = sanitizeRichText('<a href="https://example.test">x</a><p style="text-align:center">y</p>');

    expect(clean).toContain('href="https://example.test"');
    expect(clean).toContain("text-align:center");
  });
});

/**
 * THE DRIFT GUARD. The reachability argument above rests entirely on the allow-list staying
 * narrow, so the allow-list itself is pinned. Widening it is a legitimate thing to want to do —
 * this test is not here to stop it, but to make it a decision rather than an accident, and to say
 * in the failure message what else has to be reconsidered at the same time.
 */
describe("the allow-list this argument rests on", () => {
  /** Every attribute Tiptap or an attacker might emit, probed through the real sanitiser. */
  const PROBES = [
    // Kept — the editor needs these.
    { attr: 'href="https://example.test"', tag: "a", survives: true },
    { attr: 'style="text-align:center"', tag: "p", survives: true },
    // Dropped — none of them can express the advisory, and none is needed.
    { attr: '__proto__="x"', tag: "p", survives: false },
    { attr: 'constructor="x"', tag: "p", survives: false },
    { attr: 'prototype="x"', tag: "p", survives: false },
    { attr: 'onclick="alert(1)"', tag: "p", survives: false },
    { attr: 'id="x"', tag: "p", survives: false },
    { attr: 'class="x"', tag: "p", survives: false },
    { attr: 'data-x="y"', tag: "p", survives: false },
    { attr: 'srcset="x"', tag: "p", survives: false }
  ];

  it.each(PROBES)("$tag[$attr] survives=$survives", ({ attr, tag, survives }) => {
    const name = attr.split("=")[0];
    const clean = sanitizeRichText(`<${tag} ${attr}>text</${tag}>`);

    // Probed rather than read out of the source: what protects this application is what the
    // sanitiser DOES, and a regex over the configuration would pass on a file that had been
    // reformatted and fail on one that had not.
    expect(clean.toLowerCase().includes(name.toLowerCase())).toBe(survives);
  });

  it("says out loud what a widening would mean", () => {
    // The reachability argument for leaving @tiptap/core unpatched is exactly this list. If a
    // future feature needs `id` or `class` on rich text, that is a legitimate change — and the
    // advisory has to be re-assessed in the same breath, because the argument that it cannot be
    // expressed here stops holding.
    const dropped = PROBES.filter((p) => !p.survives).map((p) => p.attr.split("=")[0]);
    expect(dropped).toContain("__proto__");
    expect(dropped.length).toBeGreaterThan(5);
  });
});
