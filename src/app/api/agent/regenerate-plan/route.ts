import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { buildPlanForTrip } from "@/lib/agent/plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { trip_id?: string; num_days?: number; focus_areas?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.trip_id) {
    return NextResponse.json({ error: "trip_id required" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  try {
    const plan = await buildPlanForTrip(supabase, body.trip_id, {
      num_days: body.num_days,
      focus_areas: body.focus_areas,
    });
    return NextResponse.json({ plan });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
