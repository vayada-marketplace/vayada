"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { locationMapPins, metresBetween, type LocationMapPin } from "@vayada/domain-hotels";
import type { PricingRoom } from "@/services/api/replacementOffers";
import { chooseMaps, mapsChosen } from "@/lib/mapsChoice";
import GuestMap, { MapGate, type GuestMapPlace } from "./GuestMap";
import { formatDistance } from "./RoomPlace";

/** The property's pin as the live catalog sends it (VAY-2126), with the hotel's name and locality. */
export type MapProperty = {
  name: string;
  locality: string;
  pin: { latitude: number; longitude: number; approximate: boolean } | null;
};

/** The places guests see on the map: rooms at the property share its pin ("Main house · 2 rooms" next to rooms
 * elsewhere, VAY-2321 D8), rooms elsewhere get their own, an "Approximate area" is a circle. */
export function useGuestPlaces(
  rooms: PricingRoom[],
  property: MapProperty | null,
): { pins: LocationMapPin[]; places: GuestMapPlace[] } {
  const t = useTranslations("locationMap");
  // The hotel's location map is off.
  if (!property) return { pins: [], places: [] };
  const { pins } = locationMapPins(
    rooms.map(({ roomTypeId, name, location, atProperty }) => ({
      roomTypeId,
      name,
      address: (location?.approximate ? location.area : location?.address) ?? null,
      pin: location ? { latitude: location.latitude, longitude: location.longitude } : null,
      // A catalog from before VAY-2321 doesn't say: a room without a pin of its own is at the property.
      atProperty: atProperty ?? !location,
      approximate: location?.approximate === true,
    })),
    {
      name: property.name,
      address: property.locality || null,
      pin: property.pin && { latitude: property.pin.latitude, longitude: property.pin.longitude },
      mapDisplayMode: !property.pin ? "hidden" : property.pin.approximate ? "approximate" : "exact",
    },
  );
  const several = pins.length > 1;
  return {
    pins,
    places: pins.map((pin) => ({
      key: pin.roomTypeIds.join(),
      label:
        several && pin.kind === "property"
          ? t("mainHouse", { count: pin.roomTypeIds.length })
          : pin.label,
      latitude: pin.latitude,
      longitude: pin.longitude,
      approximate: pin.approximate,
    })),
  };
}

/** Where a room is next to the main house, for its card's location line (VAY-2324): null for a place of its
 * own without a pin yet. */
export function roomLocation(
  room: PricingRoom,
  propertyPin: MapProperty["pin"],
):
  | { atProperty: true }
  | { atProperty: false; area: string | null; distance: number | null; about: boolean }
  | null {
  // A catalog from before VAY-2321 doesn't say: a room without a pin of its own is at the property.
  if (room.atProperty ?? !room.location) return { atProperty: true };
  const own = room.location;
  if (!own) return null;
  return {
    atProperty: false,
    area: own.approximate ? (own.area ?? null) : null,
    distance: propertyPin ? metresBetween(own, propertyPin) : null,
    // Measured from or to a rounded spot: "about", in whole kilometres.
    about: own.approximate === true || propertyPin?.approximate === true,
  };
}

/** A room card's location line: "Main house", "Own location · 2.2 km from the main house", or an area's name
 * with "about 1 km". */
export function useLocationLine(
  property: MapProperty | null,
  pins: LocationMapPin[],
): (room: PricingRoom) => { text: string; mainHouse: boolean } | null {
  const t = useTranslations("locationMap");
  const locale = useLocale();
  return (room) => {
    const where = property && roomLocation(room, property.pin);
    if (!where) return null;
    // A place of its own a few metres from the main house shares its pill, so it reads the same.
    const onMainHousePin = pins.some(
      (pin) => pin.kind === "property" && pin.roomTypeIds.includes(room.roomTypeId),
    );
    if (where.atProperty || onMainHousePin) return { text: t("lineMainHouse"), mainHouse: true };
    const place = where.area ?? t("lineOwnLocation");
    if (where.distance === null) return { text: place, mainHouse: false };
    return {
      text: t(where.about ? "lineAboutFromMainHouse" : "lineFromMainHouse", {
        place,
        distance: formatDistance(where.distance, locale, where.about),
      }),
      mainHouse: false,
    };
  };
}

/** The booking page's location map (VAY-2126): shown when the hotel switched it on in Booking Admin and every
 * room is in one place; with rooms in several places the accommodations' own map replaces it (VAY-2324,
 * VAY-2325). The place is the property's public pin, or an area when the hotel shows only that (VAY-2321).
 * Booking pages talk to no third party on their own (VAY-2216), so Google Maps loads only when the guest asks
 * for it with "Show map" (remembered for this tab). */
export default function RoomsLocationMap({
  rooms,
  property,
  apiKey,
  onViewDetails,
}: {
  rooms: PricingRoom[];
  property: MapProperty;
  apiKey: string;
  onViewDetails: (roomTypeId: string) => void;
}) {
  const t = useTranslations("locationMap");
  const [requested, setRequested] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const { pins, places } = useGuestPlaces(rooms, property);
  // A place that isn't the property's (a lone villa while the hotel hides its own) lists its room, to open
  // its details.
  const listed = pins[0]?.kind === "rooms";

  // The guest's "Show map" earlier in this tab counts here too (read after mount: sessionStorage).
  useEffect(() => {
    if (mapsChosen()) setRequested(true);
  }, []);

  if (!apiKey || pins.length === 0) return null;

  return (
    <section
      aria-labelledby="location-map-title"
      className="bg-gray-50"
      data-testid="rooms-location-map"
    >
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <h2 id="location-map-title" className="text-2xl font-heading text-gray-900 md:text-3xl">
          {t("title")}
        </h2>
        <p className="mt-2 text-gray-600">{pins[0].address || property.name}</p>
        <div className={`mt-6 ${listed ? "lg:flex lg:items-start lg:gap-6" : ""}`}>
          <div className="relative h-80 w-full overflow-hidden rounded-2xl border border-gray-200 sm:h-[480px] lg:min-w-0 lg:flex-1">
            {requested ? (
              <GuestMap
                places={places}
                selected={selected}
                onSelect={setSelected}
                apiKey={apiKey}
                label={t("mapLabel")}
                className="h-full"
              />
            ) : (
              <MapGate
                className="h-full"
                onRequest={() => {
                  chooseMaps();
                  setRequested(true);
                }}
              />
            )}
          </div>
          {listed && (
            <ol
              aria-label={t("placesLabel")}
              className="mt-5 space-y-2.5 lg:mt-0 lg:w-[360px] lg:shrink-0"
            >
              {pins.map((pin, index) => (
                <li
                  key={places[index].key}
                  className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 ${
                    selected === index
                      ? "border-primary-200 bg-primary-50"
                      : "border-gray-200 bg-white"
                  }`}
                >
                  {/* Selecting a place only highlights it until the guest opens the map: Google loads on
                      "Show map" alone. */}
                  <button
                    type="button"
                    aria-current={selected === index ? "true" : undefined}
                    onClick={() => setSelected(index)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block font-semibold text-gray-900">{places[index].label}</span>
                    {pin.address && (
                      <span className="block truncate text-sm text-gray-500">{pin.address}</span>
                    )}
                  </button>
                  {pin.kind === "rooms" && pin.roomTypeIds.length === 1 && (
                    <button
                      type="button"
                      onClick={() => onViewDetails(pin.roomTypeIds[0])}
                      className="shrink-0 text-sm font-semibold text-primary-600 hover:underline"
                    >
                      {t("viewDetails")}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
