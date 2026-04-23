import { notFound } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { PlanShareView } from "@/components/workspace/PlanShareView";
import type { Place, Trip, TripPlan } from "@/types/db";

export const dynamic = "force-dynamic";

// Public share page for a trip's plan. The trip_id in the URL is the
// security boundary (same as the rest of TripBrain). Anyone with the link
// can view + print; no auth required.
export default async function PlanSharePage({
  params,
}: {
  params: { tripId: string };
}) {
  const supabase = getSupabaseServerClient();

  const [{ data: trip }, { data: plan }, { data: places }] = await Promise.all([
    supabase
      .from("trips")
      .select("id, name, destination, start_date, end_date")
      .eq("id", params.tripId)
      .maybeSingle(),
    supabase
      .from("trip_plans")
      .select("*")
      .eq("trip_id", params.tripId)
      .maybeSingle(),
    supabase
      .from("places")
      .select("id, name, lat, lng, google_place_id, category, notes")
      .eq("trip_id", params.tripId),
  ]);

  if (!trip) notFound();

  return (
    <PlanShareView
      trip={trip as Trip}
      plan={(plan as TripPlan | null) ?? null}
      places={(places as Place[] | null) ?? []}
    />
  );
}
