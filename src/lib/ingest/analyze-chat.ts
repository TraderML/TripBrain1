import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { callLlmJson } from "@/lib/llm";
import {
  ANALYZE_CHAT_SYSTEM,
  analyzeChatUser,
} from "@/lib/prompts/analyze-chat";

interface MemoryBuckets {
  open_questions: string[];
  decisions_made: string[];
  constraints: string[];
  tensions: string[];
}

/**
 * Re-derive trip_memory (open_questions / decisions_made / constraints /
 * tensions) from the most recent group chat messages, merging with the
 * existing memory. Idempotent: running twice with no new messages is a
 * no-op because the merge prompt preserves state.
 *
 * Scope: last 40 group messages. That's big enough to catch a whole
 * planning burst but small enough to stay cheap per call.
 */
export async function analyzeChatIntoTripMemory(
  supabase: SupabaseClient,
  tripId: string
): Promise<{ updated: boolean; changeCount: number }> {
  // Find the group room for this trip.
  const { data: room } = await supabase
    .from("chat_rooms")
    .select("id")
    .eq("trip_id", tripId)
    .eq("type", "group")
    .maybeSingle();
  if (!room) return { updated: false, changeCount: 0 };

  const [{ data: messages }, { data: participants }, { data: memory }] =
    await Promise.all([
      supabase
        .from("chat_messages")
        .select("content, created_at, sender_type, sender_participant_id")
        .eq("room_id", (room as { id: string }).id)
        .in("sender_type", ["user", "agent"])
        .order("created_at", { ascending: false })
        .limit(40),
      supabase
        .from("participants")
        .select("id, display_name")
        .eq("trip_id", tripId),
      supabase
        .from("trip_memory")
        .select("open_questions, decisions_made, constraints, tensions")
        .eq("trip_id", tripId)
        .maybeSingle(),
    ]);

  const msgs = (messages ?? []).slice().reverse(); // chronological
  if (msgs.length === 0) return { updated: false, changeCount: 0 };

  const parts = (participants ?? []) as Array<{
    id: string;
    display_name: string;
  }>;
  const nameById: Record<string, string> = Object.fromEntries(
    parts.map((p) => [p.id, p.display_name])
  );

  const current: MemoryBuckets = {
    open_questions: (memory as MemoryBuckets | null)?.open_questions ?? [],
    decisions_made: (memory as MemoryBuckets | null)?.decisions_made ?? [],
    constraints: (memory as MemoryBuckets | null)?.constraints ?? [],
    tensions: (memory as MemoryBuckets | null)?.tensions ?? [],
  };

  const formattedMessages = msgs.map((m) => ({
    sender:
      m.sender_type === "agent"
        ? "Agent"
        : (m.sender_participant_id
            ? nameById[m.sender_participant_id as string]
            : "Unknown") ?? "Unknown",
    content: m.content as string,
    created_at: m.created_at as string,
  }));

  const next = await callLlmJson<MemoryBuckets>({
    messages: [
      { role: "system", content: ANALYZE_CHAT_SYSTEM },
      {
        role: "user",
        content: analyzeChatUser({
          current,
          messages: formattedMessages,
          participants: parts,
        }),
      },
    ],
    maxTokens: 1800,
    temperature: 0.1,
  });

  const changed =
    JSON.stringify(next.open_questions ?? []) !==
      JSON.stringify(current.open_questions) ||
    JSON.stringify(next.decisions_made ?? []) !==
      JSON.stringify(current.decisions_made) ||
    JSON.stringify(next.constraints ?? []) !==
      JSON.stringify(current.constraints) ||
    JSON.stringify(next.tensions ?? []) !==
      JSON.stringify(current.tensions);

  if (!changed) return { updated: false, changeCount: 0 };

  const changeCount =
    Math.abs(
      (next.open_questions?.length ?? 0) - current.open_questions.length
    ) +
    Math.abs(
      (next.decisions_made?.length ?? 0) - current.decisions_made.length
    ) +
    Math.abs((next.constraints?.length ?? 0) - current.constraints.length) +
    Math.abs((next.tensions?.length ?? 0) - current.tensions.length);

  await supabase
    .from("trip_memory")
    .update({
      open_questions: next.open_questions ?? [],
      decisions_made: next.decisions_made ?? [],
      constraints: next.constraints ?? [],
      tensions: next.tensions ?? [],
      updated_at: new Date().toISOString(),
    })
    .eq("trip_id", tripId);

  return { updated: true, changeCount };
}
