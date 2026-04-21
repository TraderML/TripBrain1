import "server-only";

import type Anthropic from "@anthropic-ai/sdk";

import { callLlm, getZaiModel, type LlmMessage } from "@/lib/llm";
import { concatChunks } from "@/lib/embeddings";
import {
  executeTool,
  mainAgentTools,
  type ToolContext,
} from "@/lib/agent/tools";
import { runResearchSubagent } from "@/lib/agent/subagent-research";
import {
  agentGroupContext,
  agentGroupSystem,
} from "@/lib/prompts/agent-group";
import {
  agentPrivateContext,
  agentPrivateSystem,
} from "@/lib/prompts/agent-private";
import { computeGraphInMemory } from "@/lib/graph/build";
import { serializeGraph } from "@/lib/graph/serialize";
import { formatDigestsBlock } from "@/lib/chat/format-digests";
import type { KGEdge, KGNode } from "@/lib/graph/types";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import type {
  ChatMessage,
  ChatRoom,
  Participant,
  ParticipantProfile,
  Trip,
  TripMemory,
} from "@/types/db";

const HISTORY_LIMIT = 12;
const MAX_TURNS = 3;

function getTimeOfDay(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

export interface RunAgentArgs {
  tripId: string;
  roomId: string;
  placeholderMessageId: string;
  triggerMessageId: string;
}

export async function runAgent(args: RunAgentArgs): Promise<void> {
  const supabase = getSupabaseServerClient();
  const t0 = Date.now();

  const updatePlaceholder = async (patch: {
    content?: string;
    thinking_state?: "streaming" | "done" | "failed";
    tool_calls?: unknown[];
  }) => {
    await supabase
      .from("chat_messages")
      .update(patch)
      .eq("id", args.placeholderMessageId);
  };

  const { data: runRow } = await supabase
    .from("ai_runs")
    .insert({
      trip_id: args.tripId,
      kind: "agent.run",
      input: { trigger_message_id: args.triggerMessageId },
      model: getZaiModel(),
    })
    .select("id")
    .single();
  const runId = (runRow?.id ?? null) as string | null;

  const finalizeRun = async (patch: {
    kind?: string;
    output?: unknown;
    error?: string | null;
  }) => {
    if (!runId) return;
    await supabase
      .from("ai_runs")
      .update({ ...patch, duration_ms: Date.now() - t0 })
      .eq("id", runId);
  };

  const activationChannel = supabase.channel(`graph-activations:${args.tripId}`, {
    config: { broadcast: { self: false } },
  });
  let channelReady: Promise<void> | null = null;
  const ensureChannel = (): Promise<void> => {
    if (!channelReady) {
      channelReady = new Promise((resolve) => {
        activationChannel.subscribe((status) => {
          if (status === "SUBSCRIBED") resolve();
        });
        setTimeout(resolve, 1500);
      });
    }
    return channelReady;
  };

  const broadcastActivations = async (
    nodeIds: string[],
    reason: string
  ): Promise<void> => {
    if (!runId || nodeIds.length === 0) return;
    try {
      await ensureChannel();
      await activationChannel.send({
        type: "broadcast",
        event: "activate",
        payload: {
          trip_id: args.tripId,
          run_id: runId,
          node_ids: nodeIds,
          reason,
          at: new Date().toISOString(),
        },
      });
    } catch (e) {
      console.warn("broadcast failed (non-fatal):", e);
    }
  };

  try {
    const { data: roomData } = await supabase
      .from("chat_rooms")
      .select("*")
      .eq("id", args.roomId)
      .single();
    if (!roomData) throw new Error(`Room ${args.roomId} not found`);
    const room = roomData as ChatRoom;

    const [
      { data: tripData },
      { data: tripMemoryData },
      { data: participantsData },
      { data: triggerMsgData },
    ] = await Promise.all([
      supabase.from("trips").select("*").eq("id", args.tripId).single(),
      supabase.from("trip_memory").select("*").eq("trip_id", args.tripId).maybeSingle(),
      supabase.from("participants").select("*").eq("trip_id", args.tripId),
      supabase.from("chat_messages").select("*").eq("id", args.triggerMessageId).single(),
    ]);
    if (!tripData) throw new Error(`Trip ${args.tripId} not found`);
    if (!triggerMsgData) throw new Error("Trigger message not found");
    const trip = tripData as Trip;
    const tripMemory = (tripMemoryData ?? null) as TripMemory | null;
    const participants = (participantsData ?? []) as Participant[];
    const triggerMsg = triggerMsgData as ChatMessage;

    const { data: historyData } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("room_id", args.roomId)
      .neq("id", args.placeholderMessageId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    const history = ((historyData ?? []) as ChatMessage[]).reverse();

    const { data: profilesData } = await supabase
      .from("participant_profiles")
      .select("*")
      .in("participant_id", participants.map((p) => p.id));
    const profiles = (profilesData ?? []) as ParticipantProfile[];

    const nameById: Record<string, string> = {};
    participants.forEach((p) => { nameById[p.id] = p.display_name; });

    const profilesForPrompt = profiles.map((p) => ({
      display_name: nameById[p.participant_id] ?? "Unknown",
      ...p,
    }));

    let ragChunks = "";
    if (triggerMsg.content.trim()) {
      const { data: chunkRows } = await supabase
        .from("upload_chunks")
        .select("id, content, created_at")
        .eq("trip_id", args.tripId)
        .order("created_at", { ascending: true });
      const chunks = (chunkRows ?? []) as { id: string; content: string }[];
      ragChunks = concatChunks(chunks, 5000);
    }

    let digestsBlock = "";
    {
      const { data: digestsData } = await supabase
        .from("chat_digests")
        .select(
          "window_start, window_end, message_count, topics_active, places_mentioned, decisions_noted, questions_raised, summary"
        )
        .eq("trip_id", args.tripId)
        .order("window_start", { ascending: false })
        .limit(5);
      const digests = (digestsData ?? []) as Parameters<typeof formatDigestsBlock>[0];
      digestsBlock = formatDigestsBlock(digests, { maxDigests: 5 });
    }

    const { nodes: kgNodes, edges: kgEdges } = await computeGraphInMemory(supabase, args.tripId);
    const graphDigest =
      kgNodes.length > 0
        ? serializeGraph(
            kgNodes as unknown as KGNode[],
            kgEdges as unknown as KGEdge[],
            { maxPerKind: 25 }
          )
        : "";

    if (kgNodes.length > 0) {
      const userText = (triggerMsg.content ?? "").toLowerCase();
      const userTokens = Array.from(
        new Set(userText.split(/[^a-z0-9]+/).filter((t) => t.length >= 4))
      );
      const hitIds = new Set<string>();
      if (userTokens.length > 0) {
        for (const n of kgNodes) {
          const label = (n.label ?? "").toLowerCase();
          if (userTokens.some((tok) => label.includes(tok))) hitIds.add(n.id);
        }
      }
      if (hitIds.size > 0) {
        const expanded = new Set(hitIds);
        for (const e of kgEdges) {
          if (hitIds.has(e.src_id)) expanded.add(e.dst_id);
          if (hitIds.has(e.dst_id)) expanded.add(e.src_id);
        }
        await broadcastActivations(
          Array.from(expanded),
          `Relevant to "${triggerMsg.content.slice(0, 60)}"`
        );
      }
    }

    const mode: "group" | "private" = room.type === "group" ? "group" : "private";

    const historyForPrompt = history
      .map((m) => {
        const who =
          m.sender_type === "user"
            ? (nameById[m.sender_participant_id ?? ""] ?? "User")
            : m.sender_type === "agent"
              ? "Agent"
              : m.sender_type === "subagent"
                ? "Research Agent"
                : "System";
        return `${who}: ${m.content}`;
      })
      .join("\n");

    let systemPrompt: string;
    let contextBlock: string;

    const prependGraph = (block: string) =>
      graphDigest
        ? `TRIP KNOWLEDGE GRAPH (compiled brain — prefer this over raw RAG):\n${graphDigest}\n\n---\n\n${block}`
        : block;

    if (mode === "group") {
      systemPrompt = agentGroupSystem;
      contextBlock = prependGraph(
        agentGroupContext({
          tripMemoryJson: JSON.stringify(tripMemory ?? {}, null, 2),
          participantsJson: JSON.stringify(profilesForPrompt, null, 2),
          recentMessages: historyForPrompt,
          ragChunks,
          digestsBlock,
        })
      );
    } else {
      const ownerId = room.owner_id!;
      const ownerName = nameById[ownerId] ?? "participant";
      const ownerProfile = profiles.find((p) => p.participant_id === ownerId);

      const { data: groupRoomData } = await supabase
        .from("chat_rooms")
        .select("*")
        .eq("trip_id", args.tripId)
        .eq("type", "group")
        .maybeSingle();
      let groupRecent = "";
      if (groupRoomData) {
        const { data: groupMsgs } = await supabase
          .from("chat_messages")
          .select("*")
          .eq("room_id", (groupRoomData as ChatRoom).id)
          .order("created_at", { ascending: false })
          .limit(HISTORY_LIMIT);
        const groupMsgsOrdered = ((groupMsgs ?? []) as ChatMessage[]).reverse();
        groupRecent = groupMsgsOrdered
          .map((m) => {
            const who =
              m.sender_type === "user"
                ? (nameById[m.sender_participant_id ?? ""] ?? "User")
                : m.sender_type === "agent"
                  ? "Agent"
                  : m.sender_type === "subagent"
                    ? "Research Agent"
                    : "System";
            return `${who}: ${m.content}`;
          })
          .join("\n");
      }

      systemPrompt = agentPrivateSystem;
      contextBlock = prependGraph(
        agentPrivateContext({
          participantName: ownerName,
          profileJson: JSON.stringify(
            ownerProfile
              ? { display_name: ownerName, ...ownerProfile }
              : { display_name: ownerName },
            null,
            2
          ),
          tripMemoryJson: JSON.stringify(tripMemory ?? {}, null, 2),
          groupRecentMessages: groupRecent,
          privateRecentMessages: historyForPrompt,
          ragChunks,
          digestsBlock,
        })
      );
    }

    // Build messages — callLlm auto-extracts role:"system" items
    const messages: LlmMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "system", content: contextBlock },
      { role: "user", content: triggerMsg.content },
    ];

    const currentTimeOfDay = getTimeOfDay();
    const profilesJson = JSON.stringify(profilesForPrompt, null, 2);

    const toolCtx: ToolContext = {
      supabase,
      tripId: args.tripId,
      roomId: args.roomId,
      destination: trip.destination,
      currentParticipantId: room.owner_id ?? null,
      spawnResearchSubagent: async (subArgs) => {
        return await runResearchSubagent({
          supabase,
          tripId: args.tripId,
          roomId: args.roomId,
          description: subArgs.description,
          requesterContext: subArgs.requesterContext,
          destination: trip.destination,
          tripMemory,
          profilesJson,
          currentTimeOfDay,
        });
      },
    };

    // Tool loop
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const result = await callLlm({
        messages,
        tools: mainAgentTools,
      });

      if (result.toolCalls.length === 0) {
        const finalContent =
          result.content.trim() || "I couldn't find anything useful on that.";
        await updatePlaceholder({ content: finalContent, thinking_state: "done" });
        await finalizeRun({
          kind: `agent.${mode}`,
          output: { content: finalContent, turns: turn + 1 },
        });
        return;
      }

      await updatePlaceholder({
        content: result.content.trim() || "",
        thinking_state: "streaming",
        tool_calls: result.toolCalls.map((tc) => ({ id: tc.id, name: tc.name })),
      });

      // Push assistant turn using rawContent (Anthropic multi-turn requirement)
      messages.push({
        role: "assistant",
        content: result.rawContent,
      } as Anthropic.MessageParam);

      // Execute all tool calls in parallel
      const toolExecutions = await Promise.all(
        result.toolCalls.map(async (tc) => ({
          tc,
          result: await executeTool(tc.name, JSON.stringify(tc.input), toolCtx),
        }))
      );

      // All tool results in ONE user message (Anthropic requirement)
      messages.push({
        role: "user",
        content: toolExecutions.map(({ tc, result: toolResult }) => ({
          type: "tool_result" as const,
          tool_use_id: tc.id,
          content: toolResult,
        })),
      } as Anthropic.MessageParam);

      // If research_activity ran, the subagent wrote its own message — done
      const researchCall = result.toolCalls.find((tc) => tc.name === "research_activity");
      if (researchCall) {
        await updatePlaceholder({
          content:
            result.content?.trim() ||
            "The Research Agent has posted its findings above.",
          thinking_state: "done",
        });
        await finalizeRun({
          kind: `agent.${mode}`,
          output: { content: "Delegated to research subagent", turns: turn + 1 },
        });
        return;
      }
    }

    const fallback =
      "I've gathered enough to say: let me know if you want me to dig deeper on a specific angle.";
    await updatePlaceholder({ content: fallback, thinking_state: "done" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("runAgent failed:", msg);
    await updatePlaceholder({
      content: "Sorry, I hit an error. Try rephrasing?",
      thinking_state: "failed",
    });
    await finalizeRun({ kind: "agent.error", output: null, error: msg });
  }
}
