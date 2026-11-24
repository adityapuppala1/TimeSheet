/**
 * 7.0.0 — geofenced work sites: named circles (centre + radius) an admin defines, so a punch can say
 * "At Head office" or "Outside work sites" instead of anyone ever reading a coordinate.
 *
 * WHAT IS STORED: the matched LABEL on the record (AttendanceRecord.siteLabel). The coordinates the
 * punch carried stay where they always were (lat/lng, nulled by the retention worker); the label
 * outlives them, and it is the only location detail any person-facing view shows.
 *
 * MATCHING (pure, below): great-circle (haversine) distance to every enabled site; the nearest site
 * whose radius contains the point wins. The device's reported accuracy is NOT added to the radius —
 * a phone that says "±2 km" must not count as being at every site in town.
 *
 * THE RULE (GlobalAttendanceSettings.requireSite, web punch only — a device on the wall is at its
 * site by definition): OFF just labels; BLOCK refuses a web punch-in outside every site (or with no
 * location); ALLOW_FLAGGED records it and marks it (siteFlagged) for review.
 */
import { z } from "zod";
import { prisma } from "../config/prisma.js";

export const OUTSIDE_SITES = "Outside work sites";

export interface SiteCircle {
  name: string;
  latitude: number;
  longitude: number;
  radiusM: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. Pure; stable for antipodes and across the antimeridian. */
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  // Clamp: floating error can push h a hair above 1 at the antipode, and asin(>1) is NaN.
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(Math.max(0, h))));
}

/** The nearest site containing the point, or null. The boundary counts as inside. Pure. */
export function matchSite<T extends SiteCircle>(point: { lat: number; lng: number }, sites: readonly T[]): T | null {
  let best: { site: T; d: number } | null = null;
  for (const s of sites) {
    const d = haversineM(point, { lat: s.latitude, lng: s.longitude });
    if (d <= s.radiusM && (!best || d < best.d)) best = { site: s, d };
  }
  return best?.site ?? null;
}

/**
 * The label for a punch. null = nothing to say (no sites defined, or the punch carried no location),
 * so a workspace without sites keeps exactly the labels it had. Pure.
 */
export function siteLabelFor(point: { lat: number | null | undefined; lng: number | null | undefined }, sites: readonly SiteCircle[]): string | null {
  if (sites.length === 0 || point.lat == null || point.lng == null) return null;
  const hit = matchSite({ lat: point.lat, lng: point.lng }, sites);
  return hit ? `At ${hit.name}` : OUTSIDE_SITES;
}

export const siteBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    // 25 m is about as tight as a phone fix is honest; 50 km is a campus, not a country.
    radiusM: z.number().int().min(25).max(50_000),
    enabled: z.boolean().optional()
  })
  .strict();

export async function enabledSites(): Promise<SiteCircle[]> {
  const rows = await prisma.attendanceSite.findMany({ where: { enabled: true }, select: { name: true, latitude: true, longitude: true, radiusM: true } });
  return rows.map((r) => ({ name: r.name, latitude: Number(r.latitude), longitude: Number(r.longitude), radiusM: r.radiusM }));
}

export function publicSite(r: { id: string; name: string; latitude: unknown; longitude: unknown; radiusM: number; enabled: boolean }) {
  return { id: r.id, name: r.name, latitude: Number(r.latitude), longitude: Number(r.longitude), radiusM: r.radiusM, enabled: r.enabled };
}
