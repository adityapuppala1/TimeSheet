/**
 * `queryText` — a query-string value as text, or "" when it is not text.
 *
 * Express hands a handler `string | string[] | ParsedQs` for every key: `?search[a]=1` is an object and
 * `?search=a&search=b` an array. `String(value ?? "")` turned the object into the literal search
 * "[object Object]" (SonarQube S6551). Only a plain string — or the first of a repeated key — counts.
 */
import { describe, expect, it } from "vitest";
import { queryText } from "../../src/utils/query-text.js";

describe("queryText", () => {
  it("returns a plain string as it is", () => {
    expect(queryText("ada")).toBe("ada");
  });

  it("takes the first value of a repeated key", () => {
    expect(queryText(["ada", "bob"])).toBe("ada");
  });

  it("never turns an object into '[object Object]'", () => {
    expect(queryText({ a: "1" })).toBe("");
  });

  it("falls back for anything absent or not text", () => {
    expect(queryText(undefined)).toBe("");
    expect(queryText(42, "name")).toBe("name");
    expect(queryText([{ a: 1 }], "asc")).toBe("asc");
  });
});
