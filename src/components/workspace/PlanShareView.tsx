"use client";

import { useMemo, useState } from "react";
import { Check, ExternalLink, Link2, Printer } from "lucide-react";

import { googleMapsDayUrl } from "@/lib/plan-links";
import { cn } from "@/lib/utils";
import type { Place, Trip, TripPlan } from "@/types/db";

interface Props {
  trip: Trip;
  plan: TripPlan | null;
  places: Place[];
}

export function PlanShareView({ trip, plan, places }: Props) {
  const [copied, setCopied] = useState(false);
  const placesById = useMemo(
    () => Object.fromEntries(places.map((p) => [p.id, p])),
    [places]
  );

  const copyLink = async () => {
    if (typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const print = () => {
    if (typeof window !== "undefined") window.print();
  };

  if (!plan || plan.days.length === 0) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <h1 className="text-2xl font-bold">{trip.name}</h1>
        <p className="text-muted-foreground">No plan yet.</p>
      </main>
    );
  }

  const totalStops = plan.days.reduce((a, d) => a + d.items.length, 0);

  return (
    <>
      {/* Print-only styles: hide the action bar, force white bg + dark text,
          keep each day on its own page where possible. */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .plan-share { background: #fff !important; color: #000 !important; }
          .plan-share * { color: #000 !important; border-color: #d4d4d8 !important; }
          .plan-share a { color: #000 !important; text-decoration: none !important; }
          .plan-day { break-inside: avoid; page-break-inside: avoid; }
          .plan-day + .plan-day { page-break-before: always; }
        }
        @page { margin: 0.6in; }
      `}</style>

      <main className="plan-share mx-auto max-w-3xl px-6 py-10 text-foreground">
        {/* Action bar — hidden in print output */}
        <div className="no-print mb-8 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
          <div className="text-xs text-muted-foreground">
            Shareable plan · anyone with this link can view
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={copyLink}
              className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
            >
              {copied ? (
                <>
                  <Check className="size-3.5" /> Copied
                </>
              ) : (
                <>
                  <Link2 className="size-3.5" /> Copy link
                </>
              )}
            </button>
            <button
              type="button"
              onClick={print}
              className="inline-flex items-center gap-1.5 rounded-md border bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90"
            >
              <Printer className="size-3.5" />
              Print / Save as PDF
            </button>
          </div>
        </div>

        <header className="mb-8 border-b pb-5">
          <h1 className="text-3xl font-bold tracking-tight">{trip.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {trip.destination ? `${trip.destination} · ` : ""}
            {plan.days.length} day{plan.days.length === 1 ? "" : "s"} ·{" "}
            {totalStops} stop{totalStops === 1 ? "" : "s"}
          </p>
          {(trip.start_date || trip.end_date) ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {trip.start_date}
              {trip.start_date && trip.end_date ? " – " : ""}
              {trip.end_date}
            </p>
          ) : null}
        </header>

        <div className="space-y-10">
          {plan.days.map((day, di) => {
            const mapsUrl = googleMapsDayUrl(day, placesById);
            return (
              <section key={`share-day-${di}`} className="plan-day">
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/60 pb-2">
                  <div className="flex items-baseline gap-3">
                    <span className="text-xl font-bold text-primary">
                      Day {day.day}
                    </span>
                    <h2 className="text-lg font-semibold">{day.title}</h2>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {day.date ? <span>{day.date}</span> : null}
                    {mapsUrl ? (
                      <a
                        href={mapsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        <ExternalLink className="size-3" />
                        Open day in Google Maps
                      </a>
                    ) : null}
                  </div>
                </div>

                {day.items.length === 0 ? (
                  <p className="mt-3 text-sm italic text-muted-foreground">
                    No stops planned for this day.
                  </p>
                ) : (
                  <ol className="mt-3 space-y-3">
                    {day.items.map((item, ii) => {
                      const place = placesById[item.place_id];
                      const placeUrl = place?.google_place_id
                        ? `https://www.google.com/maps/place/?q=place_id:${place.google_place_id}`
                        : place && place.lat != null && place.lng != null
                          ? `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}`
                          : null;
                      return (
                        <li
                          key={`share-item-${di}-${ii}`}
                          className="flex items-start gap-3"
                        >
                          <span
                            className={cn(
                              "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                              "bg-primary text-primary-foreground"
                            )}
                          >
                            {ii + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                              <span className="font-medium">
                                {place?.name ?? "(removed place)"}
                              </span>
                              {item.time_hint && item.time_hint !== "any" ? (
                                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                  {item.time_hint}
                                </span>
                              ) : null}
                              {placeUrl ? (
                                <a
                                  href={placeUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-primary hover:underline"
                                >
                                  map
                                </a>
                              ) : null}
                            </div>
                            {item.notes ? (
                              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                                {item.notes}
                              </p>
                            ) : null}
                            {place?.notes && !item.notes ? (
                              <p className="mt-1 text-sm italic leading-relaxed text-muted-foreground">
                                {place.notes}
                              </p>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            );
          })}
        </div>

        <footer className="no-print mt-12 border-t pt-4 text-center text-xs text-muted-foreground">
          Made with TripBrain
        </footer>
      </main>
    </>
  );
}
