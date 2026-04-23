import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { PlanDay, TripPlan } from "@/types/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { tripId: string } }
) {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("trip_plans")
    .select("*")
    .eq("trip_id", params.tripId)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ plan: (data as TripPlan | null) ?? null });
}

export async function PUT(
  req: Request,
  { params }: { params: { tripId: string } }
) {
  let body: { title?: string; days: PlanDay[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body?.days)) {
    return NextResponse.json({ error: "days must be an array" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("trip_plans")
    .upsert(
      {
        trip_id: params.tripId,
        ...(body.title !== undefined ? { title: body.title } : {}),
        days: body.days,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "trip_id" }
    )
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ plan: data as TripPlan });
}
