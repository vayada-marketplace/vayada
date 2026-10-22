"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { locationMapPins, type LocationMapPin } from "@vayada/domain-hotels";
import { importGoogleMapsLibrary } from "@vayada/product-onboarding/googleMaps";
import type { PricingRoom } from "@/services/api/replacementOffers";

type LatLng = { lat: number; lng: number };
type GoogleMap = {
  fitBounds: (bounds: unknown, padding?: number) => void;
  panTo: (position: LatLng) => void;
};
type GoogleMarker = { addListener: (event: "click", handler: () => void) => void };
type GoogleInfoWindow = {
  setContent: (content: Node) => void;
  open: (options: { map: GoogleMap; anchor: GoogleMarker }) => void;
  close: () => void;
};
type MapsLibrary = {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => GoogleMap;
  InfoWindow: new (options?: Record<string, unknown>) => GoogleInfoWindow;
};
type MarkerLibrary = { Marker: new (options: Record<string, unknown>) => GoogleMarker };
type CoreLibrary = {
  LatLngBounds: new () => { extend: (position: LatLng) => void };
  Point: new (x: number, y: number) => unknown;
};

// The pin shape (30 × 40, point at the bottom), filled with the hotel's colour.
const PIN_PATH = "M15 0C6.7 0 0 6.7 0 15C0 26 15 40 15 40S30 26 30 15C30 6.7 23.3 0 15 0Z";

/** The booking page's location map (VAY-2126): shown when the hotel switched it on in Booking Admin. Rooms
 * with their own pin get one each; otherwise the property's public pin. Booking pages talk to no third party
 * on their own (VAY-2216), so Google Maps loads only when the guest asks for it with "Show map". */
export default function RoomsLocationMap({
  rooms,
  property,
  apiKey,
  onViewDetails,
}: {
  rooms: PricingRoom[];
  property: { name: string; locality: string; pin: { latitude: number; longitude: number } | null };
  apiKey: string;
  onViewDetails: (roomTypeId: string) => void;
}) {
  const t = useTranslations("locationMap");
  const mapRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLSpanElement>(null);
  const [requested, setRequested] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  // A place picked in the list before the map has loaded opens once it has.
  const queued = useRef<number | null>(null);
  const select = useRef<(index: number) => void>((index) => {
    queued.current = index;
    setSelected(index);
  });

  const { pins } = locationMapPins(
    rooms.map((room) => ({
      roomTypeId: room.roomTypeId,
      name: room.name,
      address: room.location?.address ?? null,
      pin: room.location
        ? { latitude: room.location.latitude, longitude: room.location.longitude }
        : null,
    })),
    {
      name: property.name,
      address: property.locality || null,
      pin: property.pin,
      // The public profile only carries a pin the hotel shows (rounded for "Approximate").
      mapDisplayMode: property.pin ? "exact" : "hidden",
    },
  );
  const several = pins.length > 1;
  const pinsKey = JSON.stringify(pins);

  useEffect(() => {
    if (!requested || !apiKey || !mapRef.current || pins.length === 0) return;
    const googleWindow = window as Window & { gm_authFailure?: () => void };
    const previous = googleWindow.gm_authFailure;
    googleWindow.gm_authFailure = () => {
      previous?.();
      setFailed(true);
    };
    let disposed = false;
    void Promise.all([
      importGoogleMapsLibrary<MapsLibrary>(apiKey, "maps"),
      importGoogleMapsLibrary<MarkerLibrary>(apiKey, "marker"),
      importGoogleMapsLibrary<CoreLibrary>(apiKey, "core"),
    ])
      .then(([{ Map, InfoWindow }, { Marker }, { LatLngBounds, Point }]) => {
        if (disposed || !mapRef.current) return;
        const positions = pins.map((pin) => ({ lat: pin.latitude, lng: pin.longitude }));
        const narrow = window.matchMedia("(max-width: 639px)").matches;
        const map = new Map(mapRef.current, {
          center: positions[0],
          zoom: 15,
          clickableIcons: false,
          disableDefaultUI: true,
          // Phones pinch to zoom; the zoom buttons would sit under the pin's popup.
          zoomControl: !narrow,
          gestureHandling: "cooperative",
        });
        if (positions.length > 1) {
          const bounds = new LatLngBounds();
          positions.forEach((position) => bounds.extend(position));
          map.fitBounds(bounds, 64);
        }
        const color = brandRef.current ? getComputedStyle(brandRef.current).color : "#1E3EDB";
        const info = new InfoWindow({ maxWidth: 260 });
        const markers = pins.map((pin, index) => {
          const marker = new Marker({
            map,
            position: positions[index],
            title: pin.label,
            ...(several && {
              label: {
                text: String(index + 1),
                color: "#FFFFFF",
                fontSize: "12px",
                fontWeight: "700",
              },
            }),
            icon: {
              path: PIN_PATH,
              fillColor: color,
              fillOpacity: 1,
              strokeColor: "#FFFFFF",
              strokeWeight: 2,
              anchor: new Point(15, 40),
              labelOrigin: new Point(15, 15),
            },
          });
          marker.addListener("click", () => select.current(index));
          return marker;
        });
        select.current = (index) => {
          setSelected(index);
          map.panTo(positions[index]);
          info.setContent(popup(pins[index], t("viewDetails"), onViewDetails));
          info.open({ map, anchor: markers[index] });
        };
        if (queued.current !== null) select.current(queued.current);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      googleWindow.gm_authFailure = previous;
    };
    // pinsKey stands for pins; the map is drawn once per set of pins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested, apiKey, pinsKey]);

  if (!apiKey || pins.length === 0) return null;

  return (
    <section
      aria-labelledby="location-map-title"
      className="bg-gray-50"
      data-testid="rooms-location-map"
    >
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <span ref={brandRef} className="hidden text-primary-600" aria-hidden="true" />
        <h2 id="location-map-title" className="text-2xl font-heading text-gray-900 md:text-3xl">
          {t("title")}
        </h2>
        <p className="mt-2 text-gray-600">
          {several ? t("severalPlaces", { count: pins.length }) : pins[0].address || property.name}
        </p>
        <div className={`mt-6 ${several ? "lg:flex lg:items-start lg:gap-6" : ""}`}>
          <div className="relative h-80 w-full overflow-hidden rounded-2xl border border-gray-200 bg-gray-100 sm:h-[480px] lg:min-w-0 lg:flex-1">
            <div
              ref={mapRef}
              role="region"
              aria-label={t("mapLabel")}
              className={`absolute inset-0 ${requested && !failed ? "" : "invisible"}`}
            />
            {(!requested || failed) && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                {failed ? (
                  <p role="status" className="text-sm text-gray-600">
                    {t("mapFailed")}
                  </p>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setRequested(true)}
                      className="rounded-full bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-700"
                    >
                      {t("showMap")}
                    </button>
                    <p className="max-w-xs text-sm text-gray-500">{t("mapNote")}</p>
                  </>
                )}
              </div>
            )}
          </div>
          {several && (
            <ol
              aria-label={t("placesLabel")}
              className="mt-5 space-y-2.5 lg:mt-0 lg:w-[360px] lg:shrink-0"
            >
              {pins.map((pin, index) => (
                <li
                  key={pin.roomTypeIds.join()}
                  className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 ${
                    selected === index
                      ? "border-primary-200 bg-primary-50"
                      : "border-gray-200 bg-white"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setRequested(true);
                      select.current(index);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-primary-600 text-xs font-bold text-white">
                      {index + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-semibold text-gray-900">{pin.label}</span>
                      {pin.address && (
                        <span className="block truncate text-sm text-gray-500">{pin.address}</span>
                      )}
                    </span>
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

/** The pin's popup, built as plain DOM for Google's InfoWindow: names are text, never HTML. */
function popup(
  pin: LocationMapPin,
  viewDetails: string,
  onViewDetails: (roomTypeId: string) => void,
) {
  const root = document.createElement("div");
  root.style.cssText = "font: inherit; padding: 2px 4px; max-width: 240px";
  const name = document.createElement("p");
  name.textContent = pin.label;
  name.style.cssText = "margin: 0; font-weight: 600; font-size: 16px; color: #111827";
  root.append(name);
  if (pin.address) {
    const address = document.createElement("p");
    address.textContent = pin.address;
    address.style.cssText = "margin: 2px 0 0; font-size: 14px; color: #6B7280";
    root.append(address);
  }
  if (pin.kind === "rooms" && pin.roomTypeIds.length === 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${viewDetails} →`;
    button.className = "text-primary-600";
    button.style.cssText =
      "margin-top: 6px; padding: 0; border: 0; background: none; font-size: 14px; font-weight: 600; cursor: pointer";
    button.addEventListener("click", () => onViewDetails(pin.roomTypeIds[0]));
    root.append(button);
  }
  return root;
}
