/**
 * Strips coordinate-bearing keys (lat, lng, latitude, longitude, location, coords — any case, any
 * depth) from an arbitrary JSON value. Used for the attendance delivery log, which shows a sender's
 * raw payload to admins: where someone was belongs on the AttendanceRecord, under the workspace's
 * location privacy settings, not in a debugging view. Returns a copy; never mutates.
 */
const COORDINATE_KEYS = new Set(["lat", "lng", "latitude", "longitude", "location", "coords"]);

export function redactCoordinates(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCoordinates);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (!COORDINATE_KEYS.has(key.toLowerCase())) out[key] = redactCoordinates(inner);
    }
    return out;
  }
  return value;
}
