/**
 * BUSY IS NOT BROKEN. A saturated provider and a misconfigured one both fail a dispatch attempt,
 * but only one of them is that provider's fault — and the circuit breaker previously counted both,
 * so a healthy Ollama under load got demoted for being popular.
 *
 * These pin the classification `callChat` routes on: both kinds fall through to the next provider,
 * only the "broken" kind counts against the provider's reliability.
 */
import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import { AppError } from "../../src/middleware/error.js";
import { isAvailabilityFailure, isBusyFailure, translateProviderError } from "../../src/services/ai.service.js";

describe("isBusyFailure — saturation, not a fault", () => {
  it("treats a 503 AppError as busy", () => {
    expect(isBusyFailure(new AppError(503, "busy"))).toBe(true);
  });

  it("does NOT treat a 502 AppError as busy — that's a real provider fault", () => {
    expect(isBusyFailure(new AppError(502, "bad key"))).toBe(false);
  });

  it("does not treat an ordinary error as busy", () => {
    expect(isBusyFailure(new Error("something else"))).toBe(false);
  });
});

describe("isAvailabilityFailure — worth trying the next provider", () => {
  it("covers both the busy (503) and broken (502) kinds", () => {
    expect(isAvailabilityFailure(new AppError(503, "busy"))).toBe(true);
    expect(isAvailabilityFailure(new AppError(502, "bad key"))).toBe(true);
  });

  it("excludes a genuine bug, which would fail identically against every provider", () => {
    // A 422/500 means the REQUEST is wrong, not the provider — falling over to another provider
    // would just burn a second one on the same broken input.
    expect(isAvailabilityFailure(new AppError(422, "malformed"))).toBe(false);
    expect(isAvailabilityFailure(new Error("TypeError"))).toBe(false);
  });
});

describe("translateProviderError — the distinction has to survive translation", () => {
  // This is where the bug lived: the dispatch loop's catch only ever sees the TRANSLATED error, so
  // classifying saturation correctly here is what makes the loop's branch possible at all.
  it("maps a provider 503 to a busy (503) AppError", () => {
    const translated = translateProviderError(new OpenAI.APIError(503, undefined, "Service Unavailable", undefined));
    expect(translated).toBeInstanceOf(AppError);
    expect((translated as AppError).statusCode).toBe(503);
    expect(isBusyFailure(translated)).toBe(true);
  });

  it("maps a status-less connection/timeout error to busy — the shape a queued-then-abandoned request takes", () => {
    // Both SDKs surface a timeout as an APIError with no status. That is exactly what a caller
    // sees after sitting behind a provider-side queue until the client gave up.
    const translated = translateProviderError(new OpenAI.APIError(undefined as never, undefined, "Request timed out", undefined));
    expect((translated as AppError).statusCode).toBe(503);
    expect(isBusyFailure(translated)).toBe(true);
  });

  it("still maps a 401 to a broken (502) AppError, so a bad key does count against the provider", () => {
    const translated = translateProviderError(new OpenAI.APIError(401, undefined, "Unauthorized", undefined));
    expect((translated as AppError).statusCode).toBe(502);
    expect(isBusyFailure(translated)).toBe(false);
    expect(isAvailabilityFailure(translated)).toBe(true);
  });

  it("still maps a 429 rate-limit to broken — that IS about this key, unlike saturation", () => {
    const translated = translateProviderError(new OpenAI.APIError(429, undefined, "Too Many Requests", undefined));
    expect((translated as AppError).statusCode).toBe(502);
    expect(isBusyFailure(translated)).toBe(false);
  });

  it("passes a non-SDK error through untouched, so a real bug still reaches the caller", () => {
    const bug = new TypeError("cannot read properties of undefined");
    expect(translateProviderError(bug)).toBe(bug);
  });
});
