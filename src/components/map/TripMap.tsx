"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MapboxMap, { Marker, Popup } from "react-map-gl";
import type { MapRef } from "react-map-gl";
import "mapbox-gl/dist/mapbox-gl.css";

const HOVER_OPEN_DELAY_MS = 120;
const HOVER_CLOSE_DELAY_MS = 200;

import { DayRouteLayer } from "@/components/map/DayRouteLayer";
import { PlaceCard } from "@/components/map/PlaceCard";
import {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
} from "@/components/map/categories";
import { useGeolocation } from "@/hooks/useGeolocation";
import { useRealtimeLocations } from "@/hooks/useRealtimeLocations";
import { cn } from "@/lib/utils";
import type { Participant, Place, PlaceCategory, Trip, TripPlan } from "@/types/db";

interface Props {
  trip: Trip;
  places: Place[];
  participants: Participant[];
  currentParticipantId: string | null;
  onAskAgent: (place: Place) => void;
  /** Full plan (day-by-day). Used to render the focused day's route. */
  plan?: TripPlan | null;
  /** Index in plan.days that's currently highlighted. null = no focus. */
  focusedDayIndex?: number | null;
}

type MapMode = "adventure" | "streets";

const MAP_STYLES: Record<MapMode, string> = {
  adventure: "mapbox://styles/mapbox/dark-v11",
  streets: "mapbox://styles/mapbox/streets-v12",
};

export function TripMap({
  trip,
  places,
  participants,
  currentParticipantId,
  onAskAgent,
  plan,
  focusedDayIndex,
}: Props) {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const [filter, setFilter] = useState<PlaceCategory | "all">("all");
  const [selected, setSelected] = useState<Place | null>(null);
  const [hovered, setHovered] = useState<Place | null>(null);
  const [mode, setMode] = useState<MapMode>("adventure");
  const mapRef = useRef<MapRef | null>(null);
  const hoverTimers = useRef<{ open?: number; close?: number }>({});

  const scheduleHover = (p: Place) => {
    if (hoverTimers.current.close) {
      window.clearTimeout(hoverTimers.current.close);
      hoverTimers.current.close = undefined;
    }
    if (hoverTimers.current.open) window.clearTimeout(hoverTimers.current.open);
    hoverTimers.current.open = window.setTimeout(() => {
      setHovered(p);
    }, HOVER_OPEN_DELAY_MS);
  };
  const scheduleHoverClose = () => {
    if (hoverTimers.current.open) {
      window.clearTimeout(hoverTimers.current.open);
      hoverTimers.current.open = undefined;
    }
    hoverTimers.current.close = window.setTimeout(() => {
      setHovered(null);
    }, HOVER_CLOSE_DELAY_MS);
  };
  const cancelHoverClose = () => {
    if (hoverTimers.current.close) {
      window.clearTimeout(hoverTimers.current.close);
      hoverTimers.current.close = undefined;
    }
  };

  const { locations } = useRealtimeLocations(trip.id);
  const { permission } = useGeolocation({
    tripId: trip.id,
    participantId: currentParticipantId,
    enabled: true,
  });

  // Adventure mode: tilted 3D with extruded buildings. Streets: flat top-down.
  const is3D = mode === "adventure";

  const myLocation = currentParticipantId
    ? locations[currentParticipantId]
    : undefined;

  const flyTo = (lat: number, lng: number, zoom = 15) => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    map.flyTo({
      center: [lng, lat],
      zoom,
      pitch: is3D ? 55 : 0,
      bearing: is3D ? -17 : 0,
      duration: 1400,
      essential: true,
    });
  };

  const participantsById = useMemo(
    () => Object.fromEntries(participants.map((p) => [p.id, p])),
    [participants]
  );

  const visible = useMemo(
    () =>
      places.filter(
        (p) =>
          p.lat != null &&
          p.lng != null &&
          (filter === "all" || p.category === filter)
      ),
    [places, filter]
  );

  // Focused-day computation: resolve the plan's ordered place_ids to the
  // actual Place rows so we can number the markers and build the polyline.
  const placesById = useMemo(
    () => Object.fromEntries(places.map((p) => [p.id, p])),
    [places]
  );
  const focusedDay =
    plan && focusedDayIndex != null ? plan.days[focusedDayIndex] ?? null : null;
  const focusedOrder = useMemo(() => {
    if (!focusedDay) return new Map<string, number>();
    const m = new Map<string, number>();
    focusedDay.items.forEach((it, i) => {
      m.set(it.place_id, i + 1);
    });
    return m;
  }, [focusedDay]);
  const focusedCoords = useMemo<[number, number][]>(() => {
    if (!focusedDay) return [];
    return focusedDay.items
      .map((it) => placesById[it.place_id])
      .filter((p) => p && p.lat != null && p.lng != null)
      .map((p) => [p.lng as number, p.lat as number]);
  }, [focusedDay, placesById]);

  // When a day gets focused, zoom the map to encompass that day's stops.
  useEffect(() => {
    if (focusedCoords.length < 1) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    if (focusedCoords.length === 1) {
      const [lng, lat] = focusedCoords[0];
      map.flyTo({ center: [lng, lat], zoom: 14, duration: 800 });
      return;
    }
    const lngs = focusedCoords.map((c) => c[0]);
    const lats = focusedCoords.map((c) => c[1]);
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ];
    map.fitBounds(bounds, { padding: 80, duration: 800, maxZoom: 15 });
  }, [focusedCoords]);

  // Center on the trip destination first, then use the centroid ONLY of
  // places within ~50km of the destination. Otherwise a single bad geocode
  // (e.g., "4RAU DELUXE Barber" resolving to Vietnam) yanks the map view
  // across continents — which is exactly what happened on the London trip.
  const { initialLat, initialLng } = useMemo(() => {
    const destLat = trip.destination_lat ?? null;
    const destLng = trip.destination_lng ?? null;

    // Haversine km between (lat1,lng1) and (lat2,lng2).
    const kmBetween = (
      lat1: number,
      lng1: number,
      lat2: number,
      lng2: number
    ): number => {
      const R = 6371;
      const toRad = (x: number) => (x * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1);
      const dLng = toRad(lng2 - lng1);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
          Math.cos(toRad(lat2)) *
          Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    };

    if (destLat != null && destLng != null) {
      const nearby = places.filter(
        (p) =>
          p.lat != null &&
          p.lng != null &&
          kmBetween(destLat, destLng, p.lat, p.lng) <= 50
      );
      if (nearby.length > 0) {
        const lat =
          nearby.reduce((s, p) => s + (p.lat as number), 0) / nearby.length;
        const lng =
          nearby.reduce((s, p) => s + (p.lng as number), 0) / nearby.length;
        return { initialLat: lat, initialLng: lng };
      }
      return { initialLat: destLat, initialLng: destLng };
    }

    // No destination coords — fall back to places centroid, then Tokyo.
    const withCoords = places.filter(
      (p) => p.lat != null && p.lng != null
    );
    if (withCoords.length > 0) {
      const lat =
        withCoords.reduce((s, p) => s + (p.lat as number), 0) /
        withCoords.length;
      const lng =
        withCoords.reduce((s, p) => s + (p.lng as number), 0) /
        withCoords.length;
      return { initialLat: lat, initialLng: lng };
    }
    return { initialLat: 35.6762, initialLng: 139.6503 };
  }, [places, trip.destination_lat, trip.destination_lng]);

  if (!token) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <h3 className="text-base font-semibold">Map unavailable</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Add <code>NEXT_PUBLIC_MAPBOX_TOKEN</code> to{" "}
            <code>.env.local</code> and reload.
          </p>
        </div>
      </div>
    );
  }

  const handleMapLoad = () => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    if (!is3D) return;
    if (map.getLayer("tripbrain-3d-buildings")) return;

    // Find the first symbol (label) layer so we insert buildings below labels.
    const layers = map.getStyle()?.layers ?? [];
    const labelLayerId = layers.find(
      (l) => l.type === "symbol" && l.layout && "text-field" in (l.layout as Record<string, unknown>)
    )?.id;

    try {
      map.addLayer(
        {
          id: "tripbrain-3d-buildings",
          source: "composite",
          "source-layer": "building",
          filter: ["==", "extrude", "true"],
          type: "fill-extrusion",
          minzoom: 14,
          paint: {
            "fill-extrusion-color": "#1f2937",
            "fill-extrusion-height": [
              "interpolate",
              ["linear"],
              ["zoom"],
              14,
              0,
              15.5,
              ["get", "height"],
            ],
            "fill-extrusion-base": [
              "interpolate",
              ["linear"],
              ["zoom"],
              14,
              0,
              15.5,
              ["get", "min_height"],
            ],
            "fill-extrusion-opacity": 0.85,
          },
        },
        labelLayerId
      );
    } catch {
      // Style may not expose `composite` source — fail silently.
    }
  };

  return (
    <div className="relative flex flex-1 flex-col">
      <div className="z-10 flex gap-1.5 overflow-x-auto border-b bg-background/80 px-4 py-2 backdrop-blur sm:px-6">
        <FilterChip
          label="All"
          active={filter === "all"}
          color="#475569"
          onClick={() => setFilter("all")}
        />
        {CATEGORY_ORDER.map((cat) => (
          <FilterChip
            key={cat}
            label={CATEGORY_LABELS[cat]}
            active={filter === cat}
            color={CATEGORY_COLORS[cat]}
            onClick={() => setFilter(cat)}
          />
        ))}
      </div>

      <div className="relative flex-1">
        <MapboxMap
          ref={mapRef}
          key={mode}
          mapboxAccessToken={token}
          initialViewState={{
            latitude: initialLat,
            longitude: initialLng,
            zoom: is3D ? 12.5 : 11.5,
            pitch: is3D ? 50 : 0,
            bearing: is3D ? -17 : 0,
          }}
          mapStyle={MAP_STYLES[mode]}
          style={{ width: "100%", height: "100%" }}
          onLoad={handleMapLoad}
        >
          {visible.map((place) => {
            const color = place.category
              ? CATEGORY_COLORS[place.category]
              : "#64748b";
            const stopNum = focusedOrder.get(place.id);
            const isFocused = stopNum != null;
            const dimmed = focusedDay != null && !isFocused;
            return (
              <Marker
                key={place.id}
                latitude={place.lat!}
                longitude={place.lng!}
                anchor="center"
                onClick={(e) => {
                  e.originalEvent.stopPropagation();
                  setSelected(place);
                }}
              >
                <button
                  type="button"
                  aria-label={place.name}
                  className={cn(
                    "group relative flex items-center justify-center transition-opacity",
                    isFocused ? "size-7" : "size-6",
                    dimmed ? "opacity-35" : "opacity-100"
                  )}
                  onMouseEnter={() => scheduleHover(place)}
                  onMouseLeave={scheduleHoverClose}
                >
                  <span
                    className="tripbrain-pulse-ring pointer-events-none absolute inset-0 rounded-full"
                    style={{ backgroundColor: color, opacity: isFocused ? 0.7 : 0.5 }}
                    aria-hidden
                  />
                  {isFocused ? (
                    <span
                      className="relative flex size-6 items-center justify-center rounded-full border-2 border-white text-[10px] font-bold text-white shadow-lg transition-transform group-hover:scale-110"
                      style={{ backgroundColor: color }}
                    >
                      {stopNum}
                    </span>
                  ) : (
                    <span
                      className="relative size-3.5 rounded-full border-2 border-white shadow-lg transition-transform group-hover:scale-125"
                      style={{ backgroundColor: color }}
                    />
                  )}
                </button>
              </Marker>
            );
          })}

          <DayRouteLayer coords={focusedCoords} />

          {Object.values(locations).map((loc) => {
            const p = participantsById[loc.participant_id];
            if (!p) return null;
            const isMe = loc.participant_id === currentParticipantId;
            return (
              <Marker
                key={`loc-${loc.participant_id}`}
                latitude={loc.lat}
                longitude={loc.lng}
                anchor="bottom"
              >
                <div
                  className="group relative flex flex-col items-center"
                  title={`${p.display_name}${isMe ? " (you)" : ""}`}
                >
                  <div className={cn("relative", isMe && "tripbrain-bob")}>
                    <span
                      className="tripbrain-pulse-ring-slow pointer-events-none absolute -inset-1 rounded-full"
                      style={{ backgroundColor: p.color, opacity: 0.5 }}
                      aria-hidden
                    />
                    <span
                      className={cn(
                        "relative flex size-10 items-center justify-center rounded-full text-sm font-bold text-white shadow-2xl",
                        isMe ? "ring-[3px] ring-white" : "ring-2 ring-black/40"
                      )}
                      style={{
                        backgroundColor: p.color,
                        backgroundImage: isMe
                          ? `linear-gradient(135deg, ${p.color}, #00000033)`
                          : undefined,
                      }}
                    >
                      {p.display_name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <span
                    className="mt-0.5 block size-1.5 rounded-full bg-black/30 blur-[1px]"
                    aria-hidden
                  />
                  <span
                    className={cn(
                      "mt-1 whitespace-nowrap rounded-full bg-background/90 px-1.5 py-0.5 text-[10px] font-semibold shadow",
                      isMe && "ring-1 ring-white/70"
                    )}
                    style={{ color: p.color }}
                  >
                    {isMe ? "You" : p.display_name}
                  </span>
                </div>
              </Marker>
            );
          })}

          {hovered && !selected ? (
            <Popup
              latitude={hovered.lat!}
              longitude={hovered.lng!}
              anchor="top"
              closeButton={false}
              closeOnClick={false}
              onClose={() => setHovered(null)}
              offset={16}
              maxWidth="320px"
            >
              <div
                onMouseEnter={cancelHoverClose}
                onMouseLeave={scheduleHoverClose}
              >
                <PlaceCard
                  place={hovered}
                  addedBy={
                    hovered.added_by
                      ? (participantsById[hovered.added_by] ?? null)
                      : null
                  }
                  onAskAgent={(p) => {
                    setHovered(null);
                    onAskAgent(p);
                  }}
                  compact
                />
              </div>
            </Popup>
          ) : null}

          {selected ? (
            <Popup
              latitude={selected.lat!}
              longitude={selected.lng!}
              anchor="top"
              closeButton={false}
              closeOnClick={false}
              onClose={() => setSelected(null)}
              offset={16}
              maxWidth="320px"
            >
              <PlaceCard
                place={selected}
                addedBy={
                  selected.added_by
                    ? (participantsById[selected.added_by] ?? null)
                    : null
                }
                onAskAgent={(p) => {
                  setSelected(null);
                  onAskAgent(p);
                }}
                onClose={() => setSelected(null)}
                onRemove={async (p) => {
                  const res = await fetch(`/api/places/${p.id}`, {
                    method: "DELETE",
                  });
                  if (!res.ok) {
                    const { error } = await res.json().catch(() => ({
                      error: "Delete failed",
                    }));
                    alert(error || "Delete failed");
                    return;
                  }
                  setSelected(null);
                }}
              />
            </Popup>
          ) : null}
        </MapboxMap>

        <div className="pointer-events-auto absolute right-3 top-3 z-10 flex flex-col items-end gap-2">
          <div className="flex overflow-hidden rounded-full border border-white/20 bg-background/80 text-xs font-medium shadow-lg backdrop-blur">
            <StyleTab
              label="3D"
              active={mode === "adventure"}
              onClick={() => setMode("adventure")}
            />
            <StyleTab
              label="Map"
              active={mode === "streets"}
              onClick={() => setMode("streets")}
            />
          </div>
          <div className="flex overflow-hidden rounded-full border border-white/20 bg-background/80 text-xs font-medium shadow-lg backdrop-blur">
            <button
              type="button"
              onClick={() => flyTo(initialLat, initialLng, 13)}
              className="px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
              title={trip.destination ?? "Trip"}
            >
              Trip
            </button>
            <button
              type="button"
              onClick={() =>
                myLocation && flyTo(myLocation.lat, myLocation.lng, 15)
              }
              disabled={!myLocation}
              className="px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title={
                myLocation ? "Center on me" : "Enable location to use this"
              }
            >
              Me
            </button>
          </div>
        </div>

        {permission === "denied" ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto w-fit rounded-full bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow">
            Location blocked — enable in browser to appear on the map
          </div>
        ) : null}

        {visible.length === 0 ? (
          <div className="pointer-events-none absolute inset-x-0 top-12 mx-auto w-fit rounded-full bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow">
            {places.length === 0
              ? "No places yet — ingestion will add pins"
              : "No places in this category"}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FilterChip({
  label,
  active,
  color,
  onClick,
}: {
  label: string;
  active: boolean;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-transparent bg-foreground text-background"
          : "border-border bg-background text-muted-foreground hover:text-foreground"
      )}
    >
      <span
        className="size-2 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      {label}
    </button>
  );
}

function StyleTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-3 py-1.5 transition-colors",
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </button>
  );
}
