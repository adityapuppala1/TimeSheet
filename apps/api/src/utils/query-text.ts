/**
 * WHAT: a query-string (or loosely typed JSON) value as text — the value itself when it is a string,
 * the first entry of a repeated key, otherwise `fallback`.
 *
 * WHY: Express types every query value as `string | string[] | ParsedQs`, so `?search[a]=1` arrives as
 * an object and `String(value ?? "")` searched for the literal "[object Object]" (SonarQube S6551).
 */
export function queryText(value: unknown, fallback = ""): string {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first : fallback;
}
