"use client";

import { useCallback, useEffect, useState } from "react";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { TripPlan } from "@/types/db";

export function useTripPlan(tripId: string | undefined) {
  const [plan, setPlan] = useState<TripPlan | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!tripId) return;
    try {
      const res = await fetch(`/api/trips/${tripId}/plan`, { cache: "no-store" });
      if (!res.ok) {
        setPlan(null);
        return;
      }
      const body = (await res.json()) as { plan: TripPlan | null };
      setPlan(body.plan ?? null);
    } catch {
      // keep previous state
    }
  }, [tripId]);

  useEffect(() => {
    if (!tripId) {
      setPlan(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    refetch().finally(() => setLoading(false));

    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel(`trip-plan:${tripId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "trip_plans",
          filter: `trip_id=eq.${tripId}`,
        },
        () => {
          refetch();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [tripId, refetch]);

  return { plan, loading, refetch, setPlan };
}
