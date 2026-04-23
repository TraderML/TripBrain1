import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { analyzeChatIntoTripMemory } from "@/lib/ingest/analyze-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  _req: Request,
  { params }: { params: { tripId: string } }
) {
  const supabase = getSupabaseServerClient();
  try {
    const result = await analyzeChatIntoTripMemory(supabase, params.tripId);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
