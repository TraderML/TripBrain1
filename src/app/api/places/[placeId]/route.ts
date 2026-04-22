import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: { placeId: string } }
) {
  const { placeId } = params;
  if (!placeId) {
    return NextResponse.json({ error: "placeId required" }, { status: 400 });
  }
  const supabase = getSupabaseServerClient();
  const { error } = await supabase.from("places").delete().eq("id", placeId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
