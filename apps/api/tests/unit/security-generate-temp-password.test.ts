/**
 * `generateTempPassword` — the one-time password every admin-driven password path now hands out
 * (create user, reset, bulk reset, CSV import).
 *
 * Tested HERE rather than through a route because it is a pure function that does no hashing: a
 * thousand draws cost microseconds, where proving the same properties through `POST /users` meant a
 * bcrypt cost-12 round per draw — ~4.6s for 25 of them locally, and a timeout on a shared CI
 * runner. The route's job is to return whatever this produces; the randomness is this function's.
 *
 * What matters about it is not "it looks random" but three specific claims the product makes:
 * it is never the published demo default, it is never the same twice, and it always satisfies a
 * complexity rule the generator is not told about.
 */
import { describe, expect, it } from "vitest";

const { generateTempPassword } = await import("../../src/utils/security.js");

/** Enough draws to catch a constant, an off-by-one alphabet, or a seeded generator. */
const DRAWS = 1000;
const sample = Array.from({ length: DRAWS }, () => generateTempPassword());

describe("what it must never be", () => {
  it("is never the demo password this repo's README publishes", () => {
    // The exact string the "Invite a teammate" form used to pre-fill. A regression here re-opens
    // the defect: every teammate invited sharing one password the whole internet can read.
    expect(sample).not.toContain("Admin@12345");
  });

  it("is never repeated", () => {
    // A constant dressed up as generated would pass every other assertion in this file.
    expect(new Set(sample).size).toBe(DRAWS);
  });

  it("contains no ambiguous characters, so it survives being read aloud or retyped", () => {
    // 0/O and 1/l/I are the pairs people transcribe wrongly, and an admin reads this one out or
    // pastes it into a chat. The tail is fixed and deliberately excluded from this rule.
    for (const password of sample.slice(0, 50)) {
      expect(password.slice(0, -4), password).not.toMatch(/[0O1lI]/);
    }
  });
});

describe("what it must always be", () => {
  it("clears a complexity rule without the generator needing to know one", () => {
    // The fixed tail exists so this holds whatever the random part happens to draw — no caller
    // configures the generator with a policy. It covers all FOUR classes: an earlier "!7a" left
    // uppercase to the draw, which omits one roughly once in 800 passwords. This assertion over
    // 200 samples is what caught that, and it is why the tail now ends in a capital.
    for (const password of sample.slice(0, 200)) {
      expect(password, password).toMatch(/[a-z]/);
      expect(password, password).toMatch(/[A-Z]/);
      expect(password, password).toMatch(/\d/);
      expect(password, password).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it("is long enough to be worth generating", () => {
    // 12 drawn characters plus the 4-character tail. Anything shorter is a password an admin would
    // reasonably decide to replace with one of their own, which is how defaults come back.
    for (const password of sample.slice(0, 200)) expect(password.length).toBeGreaterThanOrEqual(16);
  });

  it("draws from the whole alphabet rather than a corner of it", () => {
    // A broken index (say, always rounding down) would still pass every test above while emitting a
    // fraction of the alphabet. Over 1000 draws of 12 characters, every one of the 54 permitted
    // characters should appear; asserting the COUNT rather than the set keeps the failure readable.
    const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const drawn = new Set(sample.flatMap((password) => [...password.slice(0, -4)]));
    expect(drawn.size).toBe(ALPHABET.length);
  });
});

describe("cost", () => {
  it("is cheap, which is the reason these properties are tested here and not through a route", () => {
    const started = Date.now();
    for (let i = 0; i < DRAWS; i += 1) generateTempPassword();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
