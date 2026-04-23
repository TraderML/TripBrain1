import type { Place, PlanDay } from "@/types/db";

/**
 * Build a Google Maps directions URL for a day's stops in order, so the user
 * can jump straight into turn-by-turn on the Google Maps web/app (much better
 * than anything we'd render in-app).
 *
 * URL scheme reference: https://developers.google.com/maps/documentation/urls/get-started
 *
 * Strategy:
 *  - 0 places → null
 *  - 1 place  → search URL centred on that place
 *  - 2+ places → dir URL with origin/destination + up to 9 waypoints (Google's cap)
 *    The waypoint order is preserved. Rely on `google_place_id` when present
 *    so Maps lands on the exact POI; fall back to lat,lng otherwise.
 */
export function googleMapsDayUrl(
  day: PlanDay,
  placesById: Record<string, Place>
): string | null {
  const resolved = day.items
    .map((it) => placesById[it.place_id])
    .filter((p) => p && p.lat != null && p.lng != null);
  if (resolved.length === 0) return null;

  if (resolved.length === 1) {
    const p = resolved[0];
    const params = new URLSearchParams({
      api: "1",
      query: `${p.lat},${p.lng}`,
    });
    if (p.google_place_id) params.set("query_place_id", p.google_place_id);
    return `https://www.google.com/maps/search/?${params.toString()}`;
  }

  const origin = resolved[0];
  const destination = resolved[resolved.length - 1];
  const waypoints = resolved.slice(1, -1).slice(0, 9); // Google caps waypoints

  const params = new URLSearchParams({
    api: "1",
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
    travelmode: "walking",
  });
  if (origin.google_place_id)
    params.set("origin_place_id", origin.google_place_id);
  if (destination.google_place_id)
    params.set("destination_place_id", destination.google_place_id);
  if (waypoints.length > 0) {
    params.set(
      "waypoints",
      waypoints.map((p) => `${p.lat},${p.lng}`).join("|")
    );
    const placeIds = waypoints
      .map((p) => p.google_place_id)
      .filter(Boolean) as string[];
    if (placeIds.length === waypoints.length) {
      params.set("waypoint_place_ids", placeIds.join("|"));
    }
  }

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
