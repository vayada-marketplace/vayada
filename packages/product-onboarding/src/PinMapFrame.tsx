"use client";

import {
  ArrowsPointingOutIcon,
  MapPinIcon,
  ViewfinderCircleIcon,
} from "@heroicons/react/24/outline";
import { useState } from "react";

import GoogleAddressMap, {
  type MapPosition,
  type MapReference,
  type MapType,
} from "./GoogleAddressMap";

export type PinMapFrameMessages = {
  /** The Map/Satellite group's label. */
  mapType: string;
  mapView: string;
  satelliteView: string;
  dragPin: string;
  recenter: string;
  /** Over the map while there is no pin yet. */
  empty: string;
};

const mapButtonClass = "rounded-lg bg-white shadow-[0_1px_4px_rgb(0_0_0_/_20%)]";

/** The pin editor's map (VAY-2321), shared by the PMS room editor and onboarding (VAY-2444): a draggable pin,
 * click to place, Map/Satellite, Recenter, and a grey reference pin. It fills its parent, which sets the size and
 * shows what to do when the map can't load. */
export default function PinMapFrame({
  apiKey,
  latitude,
  longitude,
  markerTitle,
  messages,
  onPick,
  onUnavailable,
  reference = null,
  area = false,
  focus = null,
  attempt = 0,
}: {
  apiKey: string;
  latitude: number | null;
  longitude: number | null;
  markerTitle: string;
  messages: PinMapFrameMessages;
  onPick: (position: MapPosition) => void;
  onUnavailable: () => void;
  reference?: MapReference | null;
  /** An "Approximate area": a circle instead of the pin, without the drag hint. */
  area?: boolean;
  /** Where the map opens while there is no pin. */
  focus?: MapPosition | null;
  /** Bumped to load the map again after it failed. */
  attempt?: number;
}) {
  const [mapType, setMapType] = useState<MapType>("roadmap");
  const [recenter, setRecenter] = useState(0);
  const hasPin = latitude != null && longitude != null;
  return (
    <>
      <GoogleAddressMap
        key={attempt}
        active
        apiKey={apiKey}
        latitude={latitude}
        longitude={longitude}
        markerTitle={markerTitle}
        onPick={onPick}
        onUnavailable={onUnavailable}
        reference={reference}
        mapType={mapType}
        area={area}
        recenter={recenter}
        focus={hasPin ? null : focus}
      />
      {!hasPin && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-gray-50/70 px-6 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full border border-gray-200 bg-white">
            <MapPinIcon className="h-5 w-5 text-gray-500" />
          </span>
          <p className="text-[13px] font-medium text-gray-600">{messages.empty}</p>
        </div>
      )}
      <div
        role="group"
        aria-label={messages.mapType}
        className={`absolute left-2.5 top-2.5 flex gap-0.5 p-[3px] ${mapButtonClass}`}
      >
        {(["roadmap", "satellite"] as const).map((type) => (
          <button
            key={type}
            type="button"
            aria-pressed={mapType === type}
            onClick={() => setMapType(type)}
            className={`rounded-md px-2.5 py-1 text-[12px] font-semibold ${
              mapType === type ? "bg-gray-900 text-white" : "text-gray-600"
            }`}
          >
            {type === "roadmap" ? messages.mapView : messages.satelliteView}
          </button>
        ))}
      </div>
      {hasPin && !area && (
        <span className="pointer-events-none absolute left-2.5 top-[52px] inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1.5 text-[12px] font-medium text-gray-600 shadow">
          <ArrowsPointingOutIcon className="h-3.5 w-3.5" />
          {messages.dragPin}
        </span>
      )}
      {hasPin && (
        <button
          type="button"
          onClick={() => setRecenter((count) => count + 1)}
          className={`absolute bottom-7 right-2.5 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-semibold text-gray-700 ${mapButtonClass}`}
        >
          <ViewfinderCircleIcon className="h-3.5 w-3.5" />
          {messages.recenter}
        </button>
      )}
    </>
  );
}
