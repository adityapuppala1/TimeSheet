/**
 * The attendance delivery log shows each event's rawPayload to admins; a sender's coordinates must
 * not be part of that view (the AttendanceRecord keeps them under the privacy settings instead).
 */
import { describe, expect, it } from "vitest";
import { redactCoordinates } from "../../src/utils/redact-coordinates.js";

describe("redactCoordinates", () => {
  it("drops coordinate keys at any depth, case-insensitively, and keeps everything else", () => {
    const raw = {
      identifier: "E100",
      punchInAt: "2026-11-23T03:25:00Z",
      location: { lat: 12.97, lng: 77.59 },
      Latitude: 1,
      LONGITUDE: 2,
      device: { coords: [1, 2], Lat: 3, name: "Lobby" },
      items: [{ LNG: 4, ok: true }]
    };
    expect(redactCoordinates(raw)).toEqual({
      identifier: "E100",
      punchInAt: "2026-11-23T03:25:00Z",
      device: { name: "Lobby" },
      items: [{ ok: true }]
    });
    expect(JSON.stringify(redactCoordinates(raw))).not.toMatch(/12\.97|77\.59/);
  });

  it("does not mutate its input and passes primitives through", () => {
    const raw = { location: { lat: 1 } };
    redactCoordinates(raw);
    expect(raw.location.lat).toBe(1);
    expect(redactCoordinates(null)).toBeNull();
    expect(redactCoordinates("x")).toBe("x");
  });
});
