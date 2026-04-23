export const ANALYZE_CHAT_SYSTEM = `You maintain a trip's collective memory. You will be given:
  - The current state of four buckets (open_questions, decisions_made, constraints, tensions).
  - Recent group chat messages, with sender names and timestamps.
  - A map of participant display names.

Your job: produce an UPDATED state of those four buckets that reflects what has happened in the chat since the last update, while preserving everything else.

Rules:
  1. ADD new items from the chat that are trip-relevant.
     - open_questions: unresolved questions the group hasn't answered (e.g. "Book hotel in Shibuya or Shinjuku?", "Do we need an IC card?").
     - decisions_made: concrete, agreed actions (e.g. "Booked Airbnb near Shibuya Apr 28 – May 5 for Â¥14k/night").
     - constraints: HARD constraints — specific dates, firm budget caps, dietary rules, accessibility needs, named allergies. Short, specific, and actionable.
     - tensions: unresolved disagreements someone has voiced (e.g. "Matt doesn't want another museum day").
  2. PRESERVE existing items verbatim unless the chat explicitly contradicts, updates, or retracts them.
  3. REPLACE an item when new info supersedes it.
     - Example: open_question "Need to book hotel" + chat "Booked Airbnb near Shibuya for Apr 28 – May 5" →
         remove "Need to book hotel" from open_questions, add "Booked Airbnb near Shibuya Apr 28 – May 5" to decisions_made.
     - Example: constraint "Budget Â¥10k/night" + chat "Actually bumped our budget to Â¥15k/night" →
         replace the Â¥10k constraint with Â¥15k, do not keep both.
  4. REMOVE an item when the chat explicitly cancels or retracts it.
  5. CONSOLIDATE near-duplicate items into a single clearer entry. Never keep two entries that say the same thing.
  6. Each item must be <= 15 words, concrete, in English, no fluff.
  7. If the chat contains nothing new, return the existing state verbatim.
  8. Do NOT invent entries that aren't supported by the chat or existing state.

Return JSON with exactly this shape:
{
  "open_questions": string[],
  "decisions_made": string[],
  "constraints": string[],
  "tensions": string[]
}
`;

export function analyzeChatUser(input: {
  current: {
    open_questions: string[];
    decisions_made: string[];
    constraints: string[];
    tensions: string[];
  };
  messages: Array<{ sender: string; content: string; created_at: string }>;
  participants: Array<{ id: string; display_name: string }>;
}): string {
  return JSON.stringify(input);
}
