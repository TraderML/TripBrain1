import "server-only";

import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { callLlm, getZaiModel, type LlmMessage } from "@/lib/llm";
import {
  executeTool,
  subagentResearchTools,
  type ToolContext,
} from "@/lib/agent/tools";
import {
  subagentResearchSystem,
  subagentResearchUser,
} from "@/lib/prompts/subagent-research";
import type { TripMemory } from "@/types/db";

const MAX_TURNS = 2;

const STAGE_MESSAGES: Record<string, string> = {
  search_places: "Checking out the best spots nearby...",
  web_search: "Looking for any special events happening...",
  save_place: "Saving a great find to your map...",
};

function friendlyStage(toolNames: string[]): string {
  for (const name of toolNames) {
    if (STAGE_MESSAGES[name]) return STAGE_MESSAGES[name];
  }
  return "Digging deeper...";
}

export async function runResearchSubagent(args: {
  supabase: SupabaseClient;
  tripId: string;
  roomId: string;
  description: string;
  requesterContext: string;
  destination: string | null;
  tripMemory: TripMemory | null;
  profilesJson: string;
  currentTimeOfDay: string;
}): Promise<string> {
  const t0 = Date.now();

  const { data: placeholder, error: placeholderErr } = await args.supabase
    .from("chat_messages")
    .insert({
      room_id: args.roomId,
      sender_type: "subagent",
      sender_label: "Research Agent",
      content: "Scanning the best spots for you...",
      thinking_state: "thinking",
    })
    .select()
    .single();
  if (placeholderErr || !placeholder) {
    console.error("Subagent placeholder insert failed:", placeholderErr);
    return "Could not start research agent.";
  }

  const placeholderId = (placeholder as { id: string }).id;

  const updateSubagent = async (patch: {
    content?: string;
    thinking_state?: "streaming" | "done" | "failed";
  }) => {
    await args.supabase
      .from("chat_messages")
      .update(patch)
      .eq("id", placeholderId);
  };

  try {
    const toolCtx: ToolContext = {
      supabase: args.supabase,
      tripId: args.tripId,
      roomId: args.roomId,
      destination: args.destination,
      currentParticipantId: null,
    };

    // Build initial messages — callLlm auto-extracts role:"system" items
    const messages: LlmMessage[] = [
      { role: "system", content: subagentResearchSystem },
      {
        role: "user",
        content: subagentResearchUser({
          description: args.description,
          requesterContext: args.requesterContext,
          tripMemoryJson: JSON.stringify(args.tripMemory ?? {}, null, 2),
          profilesJson: args.profilesJson,
          currentTimeOfDay: args.currentTimeOfDay,
        }),
      },
    ];

    let lastStageInserted = "";

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const result = await callLlm({
        messages,
        tools: subagentResearchTools,
      });

      if (result.toolCalls.length === 0) {
        const finalContent =
          result.content.trim() ||
          "I couldn't find enough to recommend with confidence.";
        await updateSubagent({ content: finalContent, thinking_state: "done" });

        await args.supabase.from("ai_runs").insert({
          trip_id: args.tripId,
          kind: "subagent.research",
          input: { description: args.description },
          output: { content: finalContent, turns: turn + 1 },
          duration_ms: Date.now() - t0,
          model: getZaiModel(),
        });

        return "";
      }

      const stageMsg = friendlyStage(result.toolCalls.map((tc) => tc.name));
      if (stageMsg !== lastStageInserted) {
        lastStageInserted = stageMsg;
      }
      updateSubagent({ content: stageMsg, thinking_state: "streaming" }); // don't await

      // Push assistant turn using rawContent (Anthropic multi-turn requirement)
      messages.push({
        role: "assistant",
        content: result.rawContent,
      } as Anthropic.MessageParam);

      // Execute tools in parallel
      const toolResults = await Promise.all(
        result.toolCalls.map(async (tc) => ({
          id: tc.id,
          result: await executeTool(tc.name, JSON.stringify(tc.input), toolCtx),
        }))
      );

      // All tool results in ONE user message (Anthropic requirement)
      messages.push({
        role: "user",
        content: toolResults.map((tr) => ({
          type: "tool_result" as const,
          tool_use_id: tr.id,
          content: tr.result,
        })),
      } as Anthropic.MessageParam);
    }

    // Turn budget exhausted — force a final response without tools
    updateSubagent({
      content: "Putting it all together...",
      thinking_state: "streaming",
    }); // don't await

    const forcedResult = await callLlm({ messages });
    const fallback =
      forcedResult.content.trim() ||
      "I've checked a few options but need more time to narrow it down — try asking me something more specific.";
    await updateSubagent({ content: fallback, thinking_state: "done" });
    return "";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("runResearchSubagent failed:", msg);
    await updateSubagent({
      content: "Sorry, the research agent hit an error. Try rephrasing?",
      thinking_state: "failed",
    });
    await args.supabase.from("ai_runs").insert({
      trip_id: args.tripId,
      kind: "subagent.research",
      input: { description: args.description },
      output: null,
      error: msg,
      duration_ms: Date.now() - t0,
      model: null,
    });
    return "";
  }
}
