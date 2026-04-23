"use client";

import { useEffect, useRef } from "react";

/**
 * Auto-analyse group chat into trip_memory on a debounced cadence.
 *
 * Triggers:
 *   - Every 10 new group messages since last analysis
 *   - OR 5 min after the last new message if fewer than 10 accumulated
 *
 * Idempotent server-side: the analyzer always reads the latest 40 messages
 * and merges with existing memory, so no cursor tracking is needed here.
 *
 * Cost budget: each call is one small LLM request. Worst-case cadence is
 * one call per 10 group messages, which is cheap and keeps the dashboard
 * feeling "live" without burning tokens on every keystroke.
 */
const MESSAGES_THRESHOLD = 10;
const INACTIVITY_DEBOUNCE_MS = 5 * 60 * 1000;
// Minimum gap between server calls — guards against rapid-fire bursts.
const MIN_CALL_GAP_MS = 30 * 1000;

export function useChatMemorySync(
  tripId: string | undefined,
  groupMessageCount: number | undefined
) {
  const baselineRef = useRef<number | null>(null);
  const lastCallAtRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!tripId || groupMessageCount == null) return;
    if (baselineRef.current == null) {
      baselineRef.current = groupMessageCount;
      return;
    }

    const delta = groupMessageCount - baselineRef.current;
    if (delta <= 0) return;

    const run = async () => {
      const now = Date.now();
      if (now - lastCallAtRef.current < MIN_CALL_GAP_MS) return;
      lastCallAtRef.current = now;
      baselineRef.current = groupMessageCount;
      try {
        await fetch(`/api/trips/${tripId}/analyze-chat`, { method: "POST" });
      } catch {
        // swallow — best effort
      }
    };

    // Cancel any pending inactivity fire and reset it.
    if (timerRef.current) clearTimeout(timerRef.current);

    if (delta >= MESSAGES_THRESHOLD) {
      void run();
      return;
    }

    timerRef.current = setTimeout(() => {
      void run();
    }, INACTIVITY_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [tripId, groupMessageCount]);
}
