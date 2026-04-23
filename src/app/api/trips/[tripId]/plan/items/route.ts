import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { PlanDay, PlanItem, TimeOfDay, TripPlan } from "@/types/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PatchBody {
  op: "toggle" | "reorder" | "add" | "remove" | "move" | "updateNotes";
  dayIndex: number;
  itemIndex?: number;
  targetDayIndex?: number;
  targetItemIndex?: number;
  place_id?: string;
  notes?: string;
  checked?: boolean;
  time_hint?: TimeOfDay;
  direction?: "up" | "down"; // shortcut for reorder within a day
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function rewriteOrders(items: PlanItem[]) {
  items.forEach((it, i) => {
    it.order = i;
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: { tripId: string } }
) {
  let body: PatchBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const { data: existing, error: readErr } = await supabase
    .from("trip_plans")
    .select("*")
    .eq("trip_id", params.tripId)
    .maybeSingle();

  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  const days: PlanDay[] = clone((existing as TripPlan).days ?? []);

  const day = days[body.dayIndex];
  if (!day) {
    return NextResponse.json({ error: "dayIndex out of range" }, { status: 400 });
  }

  switch (body.op) {
    case "toggle": {
      if (body.itemIndex == null || !day.items[body.itemIndex]) {
        return NextResponse.json({ error: "itemIndex invalid" }, { status: 400 });
      }
      day.items[body.itemIndex].checked =
        body.checked ?? !day.items[body.itemIndex].checked;
      break;
    }
    case "updateNotes": {
      if (body.itemIndex == null || !day.items[body.itemIndex]) {
        return NextResponse.json({ error: "itemIndex invalid" }, { status: 400 });
      }
      day.items[body.itemIndex].notes = body.notes ?? null;
      break;
    }
    case "reorder": {
      if (body.itemIndex == null || !day.items[body.itemIndex]) {
        return NextResponse.json({ error: "itemIndex invalid" }, { status: 400 });
      }
      const from = body.itemIndex;
      const to =
        body.direction === "up"
          ? Math.max(0, from - 1)
          : body.direction === "down"
            ? Math.min(day.items.length - 1, from + 1)
            : body.targetItemIndex ?? from;
      if (to === from) break;
      const [moved] = day.items.splice(from, 1);
      day.items.splice(to, 0, moved);
      rewriteOrders(day.items);
      break;
    }
    case "add": {
      if (!body.place_id) {
        return NextResponse.json({ error: "place_id required for add" }, { status: 400 });
      }
      const newItem: PlanItem = {
        place_id: body.place_id,
        order: day.items.length,
        notes: body.notes ?? null,
        checked: false,
        time_hint: body.time_hint ?? null,
      };
      day.items.push(newItem);
      rewriteOrders(day.items);
      break;
    }
    case "remove": {
      if (body.itemIndex == null || !day.items[body.itemIndex]) {
        return NextResponse.json({ error: "itemIndex invalid" }, { status: 400 });
      }
      day.items.splice(body.itemIndex, 1);
      rewriteOrders(day.items);
      break;
    }
    case "move": {
      if (
        body.itemIndex == null ||
        body.targetDayIndex == null ||
        !day.items[body.itemIndex] ||
        !days[body.targetDayIndex]
      ) {
        return NextResponse.json(
          { error: "itemIndex or targetDayIndex invalid" },
          { status: 400 }
        );
      }
      const [moved] = day.items.splice(body.itemIndex, 1);
      const target = days[body.targetDayIndex];
      const insertAt =
        body.targetItemIndex != null
          ? Math.min(body.targetItemIndex, target.items.length)
          : target.items.length;
      target.items.splice(insertAt, 0, moved);
      rewriteOrders(day.items);
      rewriteOrders(target.items);
      break;
    }
    default:
      return NextResponse.json({ error: `Unknown op: ${body.op}` }, { status: 400 });
  }

  const { data: updated, error: writeErr } = await supabase
    .from("trip_plans")
    .update({ days, updated_at: new Date().toISOString() })
    .eq("trip_id", params.tripId)
    .select()
    .single();

  if (writeErr) {
    return NextResponse.json({ error: writeErr.message }, { status: 500 });
  }
  return NextResponse.json({ plan: updated as TripPlan });
}
