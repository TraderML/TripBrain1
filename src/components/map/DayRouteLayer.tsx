"use client";

import { Layer, Source } from "react-map-gl";

interface Props {
  /** Ordered [lng, lat] pairs for the focused day's places. */
  coords: [number, number][];
}

export function DayRouteLayer({ coords }: Props) {
  if (coords.length < 2) return null;

  const data = {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "LineString" as const,
          coordinates: coords,
        },
      },
    ],
  };

  return (
    <Source id="focused-day-route" type="geojson" data={data}>
      <Layer
        id="focused-day-route-line"
        type="line"
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{
          "line-color": "#a855f7", // matches app primary purple
          "line-width": 3,
          "line-opacity": 0.9,
          "line-dasharray": [2, 1],
        }}
      />
    </Source>
  );
}
