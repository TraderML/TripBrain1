import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { callLlmJson } from "@/lib/llm";
import type {
  PlanDay,
  PlanHistoryEntry,
  PlanItem,
  Place,
  TripPlan,
} from "@/types/db";

const HISTORY_CAP = 5;

/**
 * Prepend the current plan state to the history array, capping at HISTORY_CAP.
 * Called by both the plan builder (agent regenerate) and the PUT route
 * (manual edit save) so every non-trivial write is reversible via Undo.
 */
export function snapshotCurrentPlan(
  current: { title: string | null; days: PlanDay[]; history?: PlanHistoryEntry[] } | null
): PlanHistoryEntry[] {
  if (!current) return [];
  if (!current.days || current.days.length === 0) return current.history ?? [];
  const entry: PlanHistoryEntry = {
    title: current.title ?? "Trip Plan",
    days: current.days,
    saved_at: new Date().toISOString(),
  };
  return [entry, ...(current.history ?? [])].slice(0, HISTORY_CAP);
}

export interface BuildPlanOpts {
  num_days?: number;
  focus_areas?: string[];
}

interface LlmPlanItem {
  place_id: string;
  notes?: string | null;
  time_hint?: "morning" | "afternoon" | "evening" | "night" | "any" | null;
}
interface LlmPlanDay {
  day: number;
  date?: string | null;
  title: string;
  items: LlmPlanItem[];
}
interface LlmPlanResponse {
  days: LlmPlanDay[];
}

function diffDaysInclusive(startISO: string, endISO: string): number {
  const a = new Date(startISO);
  const b = new Date(endISO);
  const ms = b.getTime() - a.getTime();
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

function dayDateISO(startISO: string | null, offset: number): string | null {
  if (!startISO) return null;
  const d = new Date(startISO);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

/**
 * Produce a day-by-day plan for the trip and upsert it into `trip_plans`.
 * Both the agent tool `generate_plan` and the `/api/agent/regenerate-plan`
 * route call this — keep the logic in one place.
 */
export async function buildPlanForTrip(
  supabase: SupabaseClient,
  tripId: string,
  opts: BuildPlanOpts = {}
): Promise<TripPlan> {
  const [
    { data: trip },
    { data: memory },
    { data: places },
    { data: participants },
  ] = await Promise.all([
    supabase
      .from("trips")
      .select("id, destination, start_date, end_date")
      .eq("id", tripId)
      .single(),
    supabase
      .from("trip_memory")
      .select("group_preferences, constraints, priorities, decisions_made")
      .eq("trip_id", tripId)
      .maybeSingle(),
    supabase
      .from("places")
      .select("id, name, lat, lng, category, notes, time_of_day")
      .eq("trip_id", tripId),
    supabase.from("participants").select("id").eq("trip_id", tripId),
  ]);

  if (!trip) throw new Error(`Trip ${tripId} not found`);
  const placeRows = (places ?? []) as Array<
    Pick<Place, "id" | "name" | "lat" | "lng" | "category" | "notes" | "time_of_day">
  >;
  if (placeRows.length === 0) {
    // Nothing to plan — still upsert an empty plan so the sidebar can show
    // a friendly "add some places first" state instead of a generic spinner.
    return upsertPlan(supabase, tripId, []);
  }

  const pids = (participants ?? []).map((p: { id: string }) => p.id);
  const { data: profiles } = pids.length > 0
    ? await supabase
        .from("participant_profiles")
        .select(
          "personality, interests, budget_style, travel_style, food_preferences, dislikes, dealbreakers"
        )
        .in("participant_id", pids)
    : { data: [] };

  const numDays = opts.num_days
    ?? (trip.start_date && trip.end_date
        ? diffDaysInclusive(trip.start_date, trip.end_date)
        : 3);

  const llmResp = await callLlmJson<LlmPlanResponse>({
    messages: [
      {
        role: "system",
        content:
          "You are a trip planner. Produce a day-by-day itinerary from the supplied saved places. " +
          "Rules: " +
          "(1) group each day by geographic proximity so all of that day's items are within ~5km. " +
          "(2) within each day, aim for variety — ideally one food, one drink, and one activity/sight. " +
          "(3) respect dealbreakers and dislikes from the profiles. " +
          "(4) use ONLY the supplied place_ids — do not invent new places. " +
          "(5) every saved place should appear exactly once unless it strictly violates a dealbreaker. " +
          "(6) `time_hint` ∈ morning|afternoon|evening|night|any. " +
          "(7) day titles are short (3-6 words, e.g. 'Shibuya food crawl'). " +
          "Return JSON: { days: [{ day: 1, date: \"YYYY-MM-DD\" | null, title: string, items: [{ place_id, notes, time_hint }] }] }.",
      },
      {
        role: "user",
        content: JSON.stringify({
          destination: trip.destination,
          start_date: trip.start_date,
          end_date: trip.end_date,
          num_days: numDays,
          focus_areas: opts.focus_areas ?? [],
          group_preferences: memory?.group_preferences ?? [],
          constraints: memory?.constraints ?? [],
          priorities: memory?.priorities ?? [],
          decisions_made: memory?.decisions_made ?? [],
          profiles: profiles ?? [],
          places: placeRows.map((p) => ({
            id: p.id,
            name: p.name,
            lat: p.lat,
            lng: p.lng,
            category: p.category,
            time_of_day: p.time_of_day,
            notes: p.notes,
          })),
        }),
      },
    ],
    maxTokens: 4096,
    temperature: 0.2,
  });

  const validPlaceIds = new Set(placeRows.map((p) => p.id));

  const days: PlanDay[] = (llmResp.days ?? []).map((d, di) => {
    const items: PlanItem[] = (d.items ?? [])
      .filter((it) => validPlaceIds.has(it.place_id))
      .map((it, ii) => ({
        place_id: it.place_id,
        order: ii,
        notes: it.notes ?? null,
        checked: false,
        time_hint: (it.time_hint ?? null) as PlanItem["time_hint"],
      }));
    return {
      day: d.day ?? di + 1,
      date: d.date ?? dayDateISO(trip.start_date, di),
      title: d.title?.trim() || `Day ${di + 1}`,
      items,
    };
  });

  return upsertPlan(supabase, tripId, days);
}

async function upsertPlan(
  supabase: SupabaseClient,
  tripId: string,
  days: PlanDay[]
): Promise<TripPlan> {
  // Read existing plan first so we can archive its current state into history.
  // Small 2-query cost is worth the 'Undo' flow on regenerate.
  const { data: existing } = await supabase
    .from("trip_plans")
    .select("title, days, history")
    .eq("trip_id", tripId)
    .maybeSingle();

  const nextHistory = snapshotCurrentPlan(
    (existing as { title: string | null; days: PlanDay[]; history?: PlanHistoryEntry[] } | null) ?? null
  );

  const { data, error } = await supabase
    .from("trip_plans")
    .upsert(
      {
        trip_id: tripId,
        days,
        history: nextHistory,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "trip_id" }
    )
    .select()
    .single();
  if (error) throw new Error(`Plan upsert failed: ${error.message}`);
  return data as TripPlan;
}
