import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { PlanDay, PlanHistoryEntry, TripPlan } from "@/types/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Restore the most recent snapshot from trip_plans.history as the current
 * plan. The current plan is pushed to the front of history (so Undo is
 * itself reversible by hitting Undo again).
 */
export async function POST(
  _req: Request,
  { params }: { params: { tripId: string } }
) {
  const supabase = getSupabaseServerClient();

  const { data: existing, error: readErr } = await supabase
    .from("trip_plans")
    .select("title, days, history")
    .eq("trip_id", params.tripId)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }
  const typed = existing as {
    title: string | null;
    days: PlanDay[];
    history?: PlanHistoryEntry[];
  };
  const history = typed.history ?? [];
  if (history.length === 0) {
    return NextResponse.json(
      { error: "No previous version to restore" },
      { status: 400 }
    );
  }

  const [previous, ...rest] = history;
  const currentAsSnapshot: PlanHistoryEntry = {
    title: typed.title ?? "Trip Plan",
    days: typed.days ?? [],
    saved_at: new Date().toISOString(),
  };
  const nextHistory = [currentAsSnapshot, ...rest].slice(0, 5);

  const { data, error } = await supabase
    .from("trip_plans")
    .update({
      title: previous.title,
      days: previous.days,
      history: nextHistory,
      updated_at: new Date().toISOString(),
    })
    .eq("trip_id", params.tripId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ plan: data as TripPlan });
}
