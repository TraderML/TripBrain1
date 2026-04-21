import "server-only";

import Anthropic from "@anthropic-ai/sdk";

/**
 * TripBrain LLM client — Anthropic Claude.
 *
 * Wraps the Anthropic SDK with a thin compatibility layer so the rest of
 * the codebase (agent loops, ingest pipeline) can call callLlm / callLlmJson
 * the same way they did before, while getting Claude under the hood.
 */

let anthropicClient: Anthropic | undefined;

export function getAnthropicClient(): Anthropic {
  if (anthropicClient) return anthropicClient;
  // Prefer TRIPBRAIN_ANTHROPIC_KEY to avoid collisions with shell-level
  // ANTHROPIC_API_KEY (some dev setups set it to empty, which would
  // otherwise shadow the .env.local value in Next.js).
  const apiKey =
    process.env.TRIPBRAIN_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing TRIPBRAIN_ANTHROPIC_KEY (or ANTHROPIC_API_KEY) — check .env.local"
    );
  }
  anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
}

export function getAnthropicModel(): string {
  return process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
}

// Backwards-compat aliases used by pipeline.ts and ai_runs model field
export const getZaiModel = getAnthropicModel;
export const getZaiClient = getAnthropicClient;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Provider-neutral tool call returned from callLlm */
export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmCallResult {
  content: string;
  toolCalls: LlmToolCall[];
  stopReason: string;
  /** Full raw content blocks — required by agent loops to reconstruct the
   * assistant turn in Anthropic's multi-turn tool-use protocol. */
  rawContent: Anthropic.ContentBlock[];
  usage?: Anthropic.Usage;
}

/** A message that may include role:"system" items (auto-extracted before
 * the API call and merged into Anthropic's top-level system param). */
export type LlmMessage =
  | Anthropic.MessageParam
  | { role: "system"; content: string };

export interface LlmCallOptions {
  messages: LlmMessage[];
  /** Optional extra system content prepended before any extracted system messages. */
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** Instructs the model to return only JSON (via prompt — Anthropic has no API-level JSON mode). */
  jsonMode?: boolean;
  tools?: Anthropic.Tool[];
  toolChoice?: Anthropic.ToolChoice;
  model?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractSystem(messages: LlmMessage[]): {
  systemParts: string[];
  chatMessages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const chatMessages: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content as string);
    } else {
      chatMessages.push(m as Anthropic.MessageParam);
    }
  }
  return { systemParts, chatMessages };
}

// ---------------------------------------------------------------------------
// Core call
// ---------------------------------------------------------------------------

export async function callLlm(opts: LlmCallOptions): Promise<LlmCallResult> {
  const client = getAnthropicClient();
  const model = opts.model ?? getAnthropicModel();

  const { systemParts, chatMessages } = extractSystem(opts.messages);

  const jsonInstruction = opts.jsonMode
    ? "\n\nReturn ONLY valid JSON. No markdown fences, no explanation, no text outside the JSON."
    : "";

  const allSystemParts = [
    ...(opts.system ? [opts.system] : []),
    ...systemParts,
  ];
  if (jsonInstruction) allSystemParts.push(jsonInstruction);
  const systemParam =
    allSystemParts.length > 0 ? allSystemParts.join("\n\n") : undefined;

  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.3,
    ...(systemParam ? { system: systemParam } : {}),
    messages: chatMessages,
    ...(opts.tools?.length ? { tools: opts.tools } : {}),
    ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
  });

  const content = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const toolCalls: LlmToolCall[] = response.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      name: b.name,
      input: b.input as Record<string, unknown>,
    }));

  return {
    content,
    toolCalls,
    stopReason: response.stop_reason ?? "end_turn",
    rawContent: response.content,
    usage: response.usage,
  };
}

// ---------------------------------------------------------------------------
// JSON wrapper
// ---------------------------------------------------------------------------

/**
 * Call the LLM and parse the response as JSON. Retries once with a repair
 * prompt if the first response isn't valid JSON.
 */
export async function callLlmJson<T = unknown>(
  opts: LlmCallOptions
): Promise<T> {
  const first = await callLlm({ ...opts, jsonMode: true, tools: undefined });

  // Strip any markdown fences the model may have wrapped around the JSON
  const cleaned = first.content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Retry: feed the bad response back and ask for a fix
    const { systemParts, chatMessages } = extractSystem(opts.messages);
    const allSystemParts = [
      ...(opts.system ? [opts.system] : []),
      ...systemParts,
    ];

    const repaired = await callLlm({
      ...opts,
      jsonMode: true,
      tools: undefined,
      system: allSystemParts.join("\n\n") || undefined,
      messages: [
        ...chatMessages,
        { role: "assistant" as const, content: first.content },
        {
          role: "user" as const,
          content:
            "Your previous response was invalid JSON. Return ONLY valid JSON matching the expected schema. No prose, no markdown, no code fences.",
        },
      ],
    });

    const cleanedRetry = repaired.content
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    return JSON.parse(cleanedRetry) as T;
  }
}
