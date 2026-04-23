"use client";

import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Calendar,
  CheckCircle2,
  ChevronRight,
  Circle,
  Maximize2,
  Sparkles,
  Trash2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { Place, PlanItem, TripPlan } from "@/types/db";

interface Props {
  tripId: string;
  places: Place[];
  plan: TripPlan | null;
  loading: boolean;
  focusedDayIndex: number | null;
  onFocusDay: (i: number | null) => void;
  onOpenEditor: () => void;
  onRegenerate: () => Promise<void>;
  onRefetch: () => Promise<void>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function PlanSidebar({
  tripId,
  places,
  plan,
  loading,
  focusedDayIndex,
  onFocusDay,
  onOpenEditor,
  onRegenerate,
  onRefetch,
  collapsed,
  onToggleCollapsed,
}: Props) {
  const [regenerating, setRegenerating] = useState(false);
  const [pendingItem, setPendingItem] = useState<string | null>(null);

  const placesById = useMemo(
    () => Object.fromEntries(places.map((p) => [p.id, p])),
    [places]
  );

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      await onRegenerate();
    } finally {
      setRegenerating(false);
    }
  };

  const patchItem = async (body: Record<string, unknown>) => {
    const res = await fetch(`/api/trips/${tripId}/plan/items`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) await onRefetch();
  };

  const toggleChecked = async (dayIndex: number, itemIndex: number, item: PlanItem) => {
    const key = `${dayIndex}:${itemIndex}`;
    setPendingItem(key);
    try {
      await patchItem({
        op: "toggle",
        dayIndex,
        itemIndex,
        checked: !item.checked,
      });
    } finally {
      setPendingItem(null);
    }
  };

  const moveItem = (dayIndex: number, itemIndex: number, direction: "up" | "down") =>
    patchItem({ op: "reorder", dayIndex, itemIndex, direction });

  if (collapsed) {
    return (
      <aside className="flex w-14 shrink-0 flex-col items-center gap-2 border-l bg-background/40 py-3">
        <button
          type="button"
          aria-label="Expand plan"
          onClick={onToggleCollapsed}
          className="rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className="size-4 rotate-180" />
        </button>
        <Calendar className="size-4 text-muted-foreground" />
        {plan?.days.map((d, i) => (
          <button
            key={`mini-${i}`}
            type="button"
            aria-label={`Day ${d.day}`}
            onClick={() => onFocusDay(focusedDayIndex === i ? null : i)}
            className={cn(
              "flex size-8 items-center justify-center rounded-full border text-xs font-semibold transition",
              focusedDayIndex === i
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground"
            )}
          >
            {d.day}
          </button>
        ))}
      </aside>
    );
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l bg-background/40">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">
            {plan?.title ?? "Trip Plan"}
          </h2>
          <p className="text-[10px] text-muted-foreground">
            {plan
              ? `${plan.days.length} day${plan.days.length === 1 ? "" : "s"} · ${plan.days.reduce((a, d) => a + d.items.length, 0)} stops`
              : "No plan yet"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Regenerate plan"
            title="Regenerate with agent"
            onClick={handleRegenerate}
            disabled={regenerating}
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <Sparkles
              className={cn("size-4", regenerating && "animate-pulse text-primary")}
            />
          </button>
          <button
            type="button"
            aria-label="Expand editor"
            title="Open full editor"
            onClick={onOpenEditor}
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <Maximize2 className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Collapse plan"
            onClick={onToggleCollapsed}
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && !plan ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-20 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        ) : !plan || plan.days.length === 0 ? (
          <div className="m-4 rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            No plan yet.
            <br />
            Add some places to the map, then tap the ✨ icon to have the agent build a plan.
          </div>
        ) : (
          <ul className="flex flex-col">
            {plan.days.map((day, dayIndex) => {
              const focused = focusedDayIndex === dayIndex;
              const itemsDone = day.items.filter((i) => i.checked).length;
              return (
                <li key={`day-${dayIndex}`} className="border-b last:border-b-0">
                  <button
                    type="button"
                    onClick={() => onFocusDay(focused ? null : dayIndex)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-xs transition",
                      focused
                        ? "bg-primary/10 text-foreground"
                        : "hover:bg-muted/50"
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                            focused
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-muted-foreground"
                          )}
                        >
                          {day.day}
                        </span>
                        <span className="truncate font-semibold">{day.title}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 pl-7 text-[10px] text-muted-foreground">
                        {day.date ? <span>{day.date}</span> : null}
                        <span>
                          {itemsDone}/{day.items.length} done
                        </span>
                      </div>
                    </div>
                  </button>

                  {day.items.length > 0 ? (
                    <ul className="flex flex-col gap-1 px-2 pb-2">
                      {day.items.map((item, itemIndex) => {
                        const place = placesById[item.place_id];
                        const key = `${dayIndex}:${itemIndex}`;
                        return (
                          <li
                            key={`item-${dayIndex}-${itemIndex}`}
                            className={cn(
                              "group flex items-start gap-2 rounded-md p-2 text-xs transition",
                              focused ? "bg-background" : "bg-transparent",
                              item.checked && "opacity-60"
                            )}
                          >
                            <button
                              type="button"
                              aria-label={item.checked ? "Uncheck" : "Check"}
                              onClick={() => toggleChecked(dayIndex, itemIndex, item)}
                              disabled={pendingItem === key}
                              className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                            >
                              {item.checked ? (
                                <CheckCircle2 className="size-4 text-primary" />
                              ) : (
                                <Circle className="size-4" />
                              )}
                            </button>
                            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">
                              {itemIndex + 1}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div
                                className={cn(
                                  "truncate font-medium",
                                  item.checked && "line-through"
                                )}
                              >
                                {place?.name ?? "(removed place)"}
                              </div>
                              {item.notes ? (
                                <div className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">
                                  {item.notes}
                                </div>
                              ) : null}
                              {item.time_hint && item.time_hint !== "any" ? (
                                <div className="mt-0.5 text-[10px] text-muted-foreground">
                                  {item.time_hint}
                                </div>
                              ) : null}
                            </div>
                            <div className="flex shrink-0 flex-col opacity-0 transition group-hover:opacity-100">
                              <button
                                type="button"
                                aria-label="Move up"
                                disabled={itemIndex === 0}
                                onClick={() => moveItem(dayIndex, itemIndex, "up")}
                                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                              >
                                <ArrowUp className="size-3" />
                              </button>
                              <button
                                type="button"
                                aria-label="Move down"
                                disabled={itemIndex === day.items.length - 1}
                                onClick={() => moveItem(dayIndex, itemIndex, "down")}
                                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                              >
                                <ArrowDown className="size-3" />
                              </button>
                              <button
                                type="button"
                                aria-label="Remove item"
                                onClick={() =>
                                  patchItem({ op: "remove", dayIndex, itemIndex })
                                }
                                className="text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="size-3" />
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div className="px-4 pb-2 text-[10px] italic text-muted-foreground">
                      No stops yet
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
