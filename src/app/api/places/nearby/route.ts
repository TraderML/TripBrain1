import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { googlePlacesNearbySearch } from "@/lib/places";
import { callLlmJson } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// In-memory re-rank cache. Scoped per (trip, rounded coords). 10 min TTL.
// Survives per-process on Vercel — ephemeral but enough to absorb the 60s
// polling loop from NearbyPanel without burning an LLM call every refresh.
interface RerankEntry {
  at: number;
  orderedPlaceIds: string[];
  reasons: Record<string, string>;
}
const RERANK_CACHE = new Map<string, RerankEntry>();
const TEN_MIN = 10 * 60 * 1000;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tripId = url.searchParams.get("trip_id");
  if (!tripId) {
    return NextResponse.json({ error: "trip_id required" }, { status: 400 });
  }

  const latParam = url.searchParams.get("lat");
  const lngParam = url.searchParams.get("lng");

  const supabase = getSupabaseServerClient();

  let lat = latParam ? Number(latParam) : null;
  let lng = lngParam ? Number(lngParam) : null;

  if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) {
    const { data: trip } = await supabase
      .from("trips")
      .select("destination_lat, destination_lng")
      .eq("id", tripId)
      .maybeSingle();
    if (trip) {
      lat = trip.destination_lat;
      lng = trip.destination_lng;
    }
  }

  if (lat == null || lng == null) {
    return NextResponse.json(
      { error: "No coordinates available for this trip" },
      { status: 400 }
    );
  }

  const results = await googlePlacesNearbySearch(lat, lng, 1500);

  // Existing saved places → dup detection
  const { data: existing } = await supabase
    .from("places")
    .select("google_place_id")
    .eq("trip_id", tripId);
  const existingIds = new Set(
    (existing ?? []).map((p) => p.google_place_id).filter(Boolean)
  );

  // Preference context
  const { data: participants } = await supabase
    .from("participants")
    .select("id")
    .eq("trip_id", tripId);
  const pids = (participants ?? []).map((p: { id: string }) => p.id);

  const [{ data: profiles }, { data: memory }] = await Promise.all([
    pids.length > 0
      ? supabase
          .from("participant_profiles")
          .select("food_preferences, dislikes, dealbreakers, budget_style")
          .in("participant_id", pids)
      : Promise.resolve({ data: [] }),
    supabase
      .from("trip_memory")
      .select("group_preferences, constraints")
      .eq("trip_id", tripId)
      .maybeSingle(),
  ]);

  const cacheKey = `${tripId}:${lat.toFixed(3)}:${lng.toFixed(3)}`;
  const cached = RERANK_CACHE.get(cacheKey);
  const cacheFresh = cached && Date.now() - cached.at < TEN_MIN;

  let ordered = results;
  let reasons: Record<string, string> = {};

  // Only re-rank when we have preferences AND cache is stale.
  const hasPrefs =
    (profiles ?? []).length > 0 ||
    ((memory?.group_preferences as unknown[] | undefined) ?? []).length > 0;

  if (results.length > 0 && hasPrefs && !cacheFresh) {
    try {
      const ranked = await callLlmJson<{ result: { place_id: string; reason?: string }[] }>({
        messages: [
          {
            role: "system",
            content:
              "You re-rank Google Places results by how well they fit a traveling group's known preferences. " +
              "Rules: (1) honour dealbreakers strictly — exclude any place that clearly violates them. " +
              "(2) reflect food_preferences and dislikes. " +
              "(3) prefer variety across categories (mix of food, drink, sights, nightlife). " +
              "(4) use ONLY the place_ids provided. " +
              "Return JSON: { \"result\": [{ \"place_id\": string, \"reason\": string }] } — up to 12 entries, best first, reason <= 10 words.",
          },
          {
            role: "user",
            content: JSON.stringify({
              group_preferences: memory?.group_preferences ?? [],
              constraints: memory?.constraints ?? [],
              profiles: profiles ?? [],
              candidates: results.map((r) => ({
                place_id: r.place_id,
                name: r.name,
                types: r.types,
                primary_type: r.primary_type,
                rating: r.rating,
                price_level: r.price_level,
              })),
            }),
          },
        ],
        maxTokens: 1400,
        temperature: 0.2,
      });

      const rankedList = Array.isArray(ranked)
        ? (ranked as unknown as { place_id: string; reason?: string }[])
        : ranked?.result ?? [];

      const byId = new Map(results.map((r) => [r.place_id, r]));
      const top: typeof results = [];
      for (const row of rankedList) {
        const r = byId.get(row.place_id);
        if (r) {
          top.push(r);
          if (row.reason) reasons[row.place_id] = row.reason;
        }
      }
      const seen = new Set(top.map((r) => r.place_id));
      for (const r of results) if (!seen.has(r.place_id)) top.push(r);
      ordered = top;
      RERANK_CACHE.set(cacheKey, {
        at: Date.now(),
        orderedPlaceIds: ordered.map((r) => r.place_id),
        reasons,
      });
    } catch (e) {
      console.warn("Nearby re-rank failed — falling back to raw order:", e);
    }
  } else if (cacheFresh && cached) {
    const byId = new Map(results.map((r) => [r.place_id, r]));
    const top: typeof results = [];
    for (const id of cached.orderedPlaceIds) {
      const r = byId.get(id);
      if (r) top.push(r);
    }
    const seen = new Set(top.map((r) => r.place_id));
    for (const r of results) if (!seen.has(r.place_id)) top.push(r);
    ordered = top;
    reasons = cached.reasons;
  }

  const enriched = ordered.map((r) => ({
    ...r,
    already_saved: existingIds.has(r.place_id),
    reason: reasons[r.place_id],
  }));

  return NextResponse.json(
    { results: enriched },
    { headers: { "cache-control": "public, max-age=60" } }
  );
}
