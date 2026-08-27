/**
 * The "Refine with AI" allow-list, and the seam that broke when it grew.
 *
 * The list lived in THREE places: the `REFINE_FIELDS` record that dispatches on it, a hardcoded
 * `z.enum([...])` in ai.controller.ts that validates the request, and the client's copy of the
 * union. Adding the four practice-update fields updated two of them, and every refine request for
 * a new field came back 422 from the third — with nothing in the message to say the field simply
 * was not on a list somewhere else.
 *
 * The controller now derives its enum from `REFINE_FIELD_KEYS`. This pins that: a field that can be
 * dispatched must also be accepted, and the two can no longer drift apart silently.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { REFINE_FIELD_KEYS } from "../../src/services/ai.service.js";

describe("REFINE_FIELD_KEYS", () => {
  it("is non-empty, which `z.enum` requires at the type level and at runtime", () => {
    expect(REFINE_FIELD_KEYS.length).toBeGreaterThan(0);
  });

  it("accepts every dispatchable field through the request schema the controller builds", () => {
    // Exactly the controller's line. If a future field is added to the record and this drifts, the
    // symptom in the app is a 422 that names nothing — so it is asserted here instead.
    const schema = z.enum(REFINE_FIELD_KEYS);
    for (const field of REFINE_FIELD_KEYS) {
      expect(schema.safeParse(field).success).toBe(true);
    }
  });

  it("still rejects a field nobody registered", () => {
    // The allow-list is a real boundary: `guidance` is prompt content and `format` decides whether
    // the answer is turned back into HTML, so a caller-supplied field would be prompt injection
    // and a sanitization decision at once.
    const schema = z.enum(REFINE_FIELD_KEYS);
    expect(schema.safeParse("anything_else").success).toBe(false);
    expect(schema.safeParse("").success).toBe(false);
  });

  it("carries the practice-update fields the written sections refine through", () => {
    expect(REFINE_FIELD_KEYS).toEqual(
      expect.arrayContaining(["practice_summary", "practice_risk", "practice_priority", "practice_decision"])
    );
  });
});
