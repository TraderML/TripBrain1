"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ExternalLink,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { googleMapsDayUrl } from "@/lib/plan-links";
import type { Place, PlanDay, TripPlan } from "@/types/db";

interface Props {
  open: boolean;
  onClose: () => void;
  tripId: string;
  places: Place[];
  plan: TripPlan | null;
  onSaved: (plan: TripPlan) => void;
  onRegenerate: () => Promise<TripPlan | null>;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function PlanEditorModal({
  open,
  onClose,
  tripId,
  places,
  plan,
  onSaved,
  onRegenerate,
}: Props) {
  const [title, setTitle] = useState(plan?.title ?? "Trip Plan");
  const [days, setDays] = useState<PlanDay[]>(plan?.days ?? []);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle(plan?.title ?? "Trip Plan");
      setDays(clone(plan?.days ?? []));
    }
  }, [open, plan]);

  const placesById = useMemo(
    () => Object.fromEntries(places.map((p) => [p.id, p])),
    [places]
  );

  const usedPlaceIds = useMemo(() => {
    const s = new Set<string>();
    for (const d of days) for (const i of d.items) s.add(i.place_id);
    return s;
  }, [days]);

  const unusedPlaces = places.filter((p) => !usedPlaceIds.has(p.id));

  const updateDay = (i: number, patch: Partial<PlanDay>) => {
    setDays((prev) => prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  };

  const moveItem = (di: number, ii: number, dir: "up" | "down") => {
    setDays((prev) => {
      const next = clone(prev);
      const day = next[di];
      if (!day) return prev;
      const j = dir === "up" ? ii - 1 : ii + 1;
      if (j < 0 || j >= day.items.length) return prev;
      [day.items[ii], day.items[j]] = [day.items[j], day.items[ii]];
      day.items.forEach((it, idx) => {
        it.order = idx;
      });
      return next;
    });
  };

  const removeItem = (di: number, ii: number) => {
    setDays((prev) => {
      const next = clone(prev);
      next[di].items.splice(ii, 1);
      next[di].items.forEach((it, idx) => {
        it.order = idx;
      });
      return next;
    });
  };

  const moveItemToDay = (di: number, ii: number, targetDayIndex: number) => {
    if (targetDayIndex === di) return;
    setDays((prev) => {
      const next = clone(prev);
      const [moved] = next[di].items.splice(ii, 1);
      next[targetDayIndex].items.push(moved);
      next[di].items.forEach((it, idx) => {
        it.order = idx;
      });
      next[targetDayIndex].items.forEach((it, idx) => {
        it.order = idx;
      });
      return next;
    });
  };

  const addItem = (di: number, place_id: string) => {
    setDays((prev) => {
      const next = clone(prev);
      next[di].items.push({
        place_id,
        order: next[di].items.length,
        notes: null,
        checked: false,
        time_hint: null,
      });
      return next;
    });
  };

  const updateItemNotes = (di: number, ii: number, notes: string) => {
    setDays((prev) => {
      const next = clone(prev);
      next[di].items[ii].notes = notes || null;
      return next;
    });
  };

  const toggleChecked = (di: number, ii: number) => {
    setDays((prev) => {
      const next = clone(prev);
      next[di].items[ii].checked = !next[di].items[ii].checked;
      return next;
    });
  };

  const addDay = () => {
    setDays((prev) => [
      ...prev,
      {
        day: prev.length + 1,
        date: null,
        title: `Day ${prev.length + 1}`,
        items: [],
      },
    ]);
  };

  const removeDay = (di: number) => {
    if (!confirm("Remove this day and all its items?")) return;
    setDays((prev) =>
      prev
        .filter((_, i) => i !== di)
        .map((d, i) => ({ ...d, day: i + 1 }))
    );
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, days }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Save failed" }));
        alert(error ?? "Save failed");
        return;
      }
      const body = (await res.json()) as { plan: TripPlan };
      onSaved(body.plan);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleRegenerate = async () => {
    if (!confirm("Replace the current plan with a freshly-generated one?")) return;
    setRegenerating(true);
    try {
      const fresh = await onRegenerate();
      if (fresh) {
        setTitle(fresh.title);
        setDays(clone(fresh.days));
      }
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[90vh] w-[95vw] max-w-5xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full border-none bg-transparent text-xl font-bold focus:outline-none"
              placeholder="Trip Plan"
            />
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex flex-col gap-4">
            {days.length === 0 ? (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                No days yet.
                <div className="mt-3">
                  <Button onClick={addDay} size="sm">
                    <Plus className="size-4" /> Add a day
                  </Button>
                  <span className="mx-2 text-xs">or</span>
                  <Button
                    onClick={handleRegenerate}
                    size="sm"
                    variant="outline"
                    disabled={regenerating}
                  >
                    <Sparkles className={cn("size-4", regenerating && "animate-pulse")} />
                    Generate with agent
                  </Button>
                </div>
              </div>
            ) : null}

            {days.map((day, di) => (
              <section
                key={`edit-day-${di}`}
                className="rounded-md border bg-card p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                    {day.day}
                  </span>
                  <input
                    type="text"
                    value={day.title}
                    onChange={(e) => updateDay(di, { title: e.target.value })}
                    className="flex-1 min-w-[160px] rounded-md border bg-background px-2 py-1 text-sm font-semibold"
                    placeholder={`Day ${di + 1} title`}
                  />
                  <input
                    type="date"
                    value={day.date ?? ""}
                    onChange={(e) => updateDay(di, { date: e.target.value || null })}
                    className="rounded-md border bg-background px-2 py-1 text-xs"
                  />
                  {(() => {
                    const url = googleMapsDayUrl(day, placesById);
                    return url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="Open day in Google Maps"
                        title="Open day's route in Google Maps"
                        className="ml-auto rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                      >
                        <ExternalLink className="size-4" />
                      </a>
                    ) : null;
                  })()}
                  <button
                    type="button"
                    onClick={() => removeDay(di)}
                    aria-label="Remove day"
                    className={cn(
                      "rounded-md p-1 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive",
                      !googleMapsDayUrl(day, placesById) && "ml-auto"
                    )}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>

                <ul className="mt-3 flex flex-col gap-2">
                  {day.items.map((item, ii) => {
                    const place = placesById[item.place_id];
                    return (
                      <li
                        key={`e-item-${di}-${ii}`}
                        className="flex items-start gap-2 rounded-md border bg-background p-2"
                      >
                        <input
                          type="checkbox"
                          checked={item.checked}
                          onChange={() => toggleChecked(di, ii)}
                          className="mt-1"
                          aria-label="Checked"
                        />
                        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                          {ii + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">
                            {place?.name ?? "(removed place)"}
                          </div>
                          <textarea
                            value={item.notes ?? ""}
                            onChange={(e) => updateItemNotes(di, ii, e.target.value)}
                            placeholder="Notes…"
                            rows={1}
                            className="mt-1 w-full resize-none rounded-md border bg-background px-2 py-1 text-xs"
                          />
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <button
                            type="button"
                            onClick={() => moveItem(di, ii, "up")}
                            disabled={ii === 0}
                            aria-label="Move up"
                            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                          >
                            <ArrowUp className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveItem(di, ii, "down")}
                            disabled={ii === day.items.length - 1}
                            aria-label="Move down"
                            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                          >
                            <ArrowDown className="size-3.5" />
                          </button>
                        </div>
                        <select
                          value=""
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === "") return;
                            moveItemToDay(di, ii, parseInt(v));
                          }}
                          className="shrink-0 rounded-md border bg-background px-1 py-0.5 text-[10px]"
                          aria-label="Move to day"
                          title="Move to day"
                        >
                          <option value="">→ day</option>
                          {days.map((d, i) =>
                            i !== di ? (
                              <option key={i} value={i}>
                                Day {d.day}
                              </option>
                            ) : null
                          )}
                        </select>
                        <button
                          type="button"
                          onClick={() => removeItem(di, ii)}
                          aria-label="Remove item"
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </li>
                    );
                  })}
                </ul>

                {unusedPlaces.length > 0 ? (
                  <div className="mt-2">
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        if (!e.target.value) return;
                        addItem(di, e.target.value);
                        e.target.value = "";
                      }}
                      className="w-full rounded-md border bg-background px-2 py-1 text-xs"
                    >
                      <option value="">+ Add a saved place…</option>
                      {unusedPlaces.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </section>
            ))}

            {days.length > 0 ? (
              <Button onClick={addDay} size="sm" variant="outline" className="self-start">
                <Plus className="size-4" /> Add day
              </Button>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t px-6 py-3">
          <Button
            onClick={handleRegenerate}
            variant="outline"
            disabled={regenerating}
          >
            <Sparkles className={cn("size-4", regenerating && "animate-pulse")} />
            Regenerate
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
              {!saving ? <ArrowRight className="size-4" /> : null}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
