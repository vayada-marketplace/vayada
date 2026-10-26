"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { metresBetween } from "@vayada/domain-hotels";
import GuestMap, { MapGate } from "@/components/booking/GuestMap";
import {
  NearbyNumber,
  NearbyPlaceCard,
  closeNearby,
  nearbyOnMap,
  useNearbyCategoryName,
  useNearbyLayer,
  type NearbyReference,
} from "@/components/booking/NearbyMapLayer";
import { formatDistance } from "@/components/booking/RoomPlace";
import BookingFooter from "@/components/layout/BookingFooter";
import BookingNavigation from "@/components/layout/BookingNavigation";
import { useHotel, useSlug } from "@/contexts/HotelContext";
import { Link } from "@/i18n/navigation";
import { placeAddress, placeDirectionsUrl, type StayPlace } from "@/lib/bookingStay";
import { directionsUrl } from "@/lib/confirmationDisplay";
import { chooseMaps, mapsChosen } from "@/lib/mapsChoice";
import { readLastBooking } from "@/lib/storage/bookingDraft";
import { bookingService } from "@/services/api/booking";

/** VAY-2360: "Around {hotel}", opened from the confirmation page's Directions: the hotel's nearby places (its
 * Nearby places editor, VAY-2326) as a numbered list beside a map, both following one filter and one
 * selection. Google loads only after "Show map" (VAY-2216); the list works without it. Distances count from
 * the booked guest's exact place when this browser knows the booking, else from the hotel's public pin. */
export default function AroundPageClient({ reference }: { reference: string }) {
  const t = useTranslations("around");
  const tn = useTranslations("nearbyMap");
  const locale = useLocale();
  const categoryName = useNearbyCategoryName();
  const { hotel } = useHotel();
  const { slug } = useSlug();
  const layer = useNearbyLayer(slug, true, false);
  const [place, setPlace] = useState<StayPlace | null>(null);
  const [showMap, setShowMap] = useState(false);
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() ?? "";

  useEffect(() => {
    if (mapsChosen()) setShowMap(true);
    const stored = readLastBooking();
    if (stored?.bookingReference !== reference || !stored.id || !stored.guestEmail) return;
    let cancelled = false;
    bookingService
      .stay(slug, stored.id, stored.guestEmail)
      .then((details) => {
        if (!cancelled) setPlace(details.places[0] ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [reference, slug]);

  // A public pin with two decimals or fewer is the hotel's rounded "approximate" location.
  const publicPin = hotel.mapPin;
  const rounded =
    !!publicPin &&
    [publicPin.latitude, publicPin.longitude].every(
      (value) => (String(value).split(".")[1] ?? "").length <= 2,
    );
  const pin = place?.pin ?? publicPin ?? null;
  const from: NearbyReference | null = pin && {
    ...pin,
    approximate: !place?.pin && rounded,
    kind: "property",
  };
  // The exact place (its pin, else its address), else the hotel's public pin.
  const hotelDirections =
    (place && placeDirectionsUrl(place, placeAddress(place, locale))) ||
    (publicPin ? directionsUrl(publicPin, hotel.name, hotel.location) : null);
  const numbers = Object.fromEntries(layer.places.map((nearby, index) => [nearby.id, index + 1]));
  const shown = layer.categories.filter((category) => !layer.hidden.includes(category.id));
  const only = shown.length === 1 && layer.categories.length > 1 ? shown[0]!.id : null;
  const chip = (on: boolean) =>
    `inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm font-semibold sm:min-h-[36px] ${
      on ? "border-primary-700 bg-primary-700 text-white" : "border-gray-300 bg-white text-gray-900"
    }`;
  const distance = (nearby: (typeof layer.places)[number]) => {
    if (!from) return null;
    const text = formatDistance(metresBetween(nearby, from), locale, from.approximate);
    return tn(from.approximate ? "fromPropertyAbout" : "fromProperty", { distance: text });
  };

  const map = from && apiKey && (
    <div className="relative h-80 overflow-hidden rounded-2xl border border-gray-200 sm:h-[560px] lg:h-[640px] lg:rounded-[20px]">
      {showMap ? (
        <GuestMap
          places={[
            {
              key: "hotel",
              label: hotel.name,
              latitude: from.latitude,
              longitude: from.longitude,
              approximate: from.approximate,
            },
          ]}
          selected={null}
          onSelect={() => {}}
          apiKey={apiKey}
          label={t("mapLabel", { hotel: hotel.name })}
          className="h-full"
          nearby={{ ...nearbyOnMap(layer), numbers }}
        />
      ) : (
        <MapGate
          className="h-full"
          onRequest={() => {
            chooseMaps();
            setShowMap(true);
          }}
        />
      )}
      {layer.selected && (
        <NearbyPlaceCard
          place={layer.selected}
          reference={from}
          onClose={() => closeNearby(layer)}
          className="absolute bottom-10 left-4 right-4 z-10 hidden sm:right-auto sm:block sm:w-[340px]"
        />
      )}
    </div>
  );

  return (
    <div className="flex min-h-screen flex-col bg-accent">
      <BookingNavigation solid />
      <main className="mx-auto flex w-full max-w-[1104px] flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Link
              href={`/booking/${encodeURIComponent(reference)}`}
              className="flex items-center gap-2 self-start font-semibold text-primary-700 hover:underline"
            >
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"
                />
              </svg>
              {t("back")}
            </Link>
            <h1 className="font-heading text-[30px] font-bold leading-9 tracking-[-0.02em] text-gray-900 sm:text-[44px] sm:leading-[52px]">
              {t("title", { hotel: hotel.name })}
            </h1>
            <p className="text-gray-600 sm:text-[17px]">{t("subtitle")}</p>
          </div>
          {hotelDirections && (
            <a
              href={hotelDirections}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-primary-700 px-5 font-semibold text-white hover:bg-primary-800"
            >
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 24 24"
              >
                <path d="m3 11 19-9-9 19-2-8-8-2z" />
              </svg>
              {t("directions", { hotel: hotel.name })}
            </a>
          )}
        </div>

        {layer.places.length === 0 ? (
          <div className="flex flex-col gap-6 lg:flex-row-reverse lg:items-start">
            <div className="lg:flex-1">{map}</div>
            <p className="text-gray-600 lg:w-[360px]">{t("empty")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4 lg:flex-row-reverse lg:items-start lg:gap-10">
            <div className="flex min-w-0 flex-col gap-3 lg:flex-1">
              {map}
              {layer.selected && (
                <NearbyPlaceCard
                  place={layer.selected}
                  reference={from}
                  onClose={() => closeNearby(layer)}
                  className={from && apiKey ? "sm:hidden" : ""}
                />
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-3.5 lg:w-[360px] lg:shrink-0">
              {layer.categories.length > 1 && (
                <div
                  role="group"
                  aria-label={tn("filtersLabel")}
                  className="-mr-4 flex gap-2 overflow-x-auto pr-4 [scrollbar-width:none] sm:mr-0 sm:flex-wrap sm:pr-0 [&::-webkit-scrollbar]:hidden"
                >
                  <button
                    type="button"
                    aria-pressed={layer.hidden.length === 0}
                    onClick={() => layer.only(null)}
                    className={chip(layer.hidden.length === 0)}
                  >
                    {t("all")}
                  </button>
                  {layer.categories.map((category) => {
                    const on = only === category.id;
                    return (
                      <button
                        key={category.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => {
                          if (layer.selected && layer.selected.category.id !== category.id)
                            layer.close();
                          layer.only(category.id);
                        }}
                        className={chip(on)}
                      >
                        {categoryName(category)}
                      </button>
                    );
                  })}
                </div>
              )}
              <ol
                aria-label={t("listLabel")}
                className="flex flex-col gap-2.5 lg:max-h-[580px] lg:overflow-y-auto lg:pr-1"
              >
                {layer.visible.map((nearby) => {
                  const selected = layer.selected?.id === nearby.id;
                  return (
                    <li key={nearby.id}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => (selected ? layer.close() : layer.select(nearby.id))}
                        className={`flex w-full items-start gap-3 rounded-[14px] border bg-white px-3.5 py-3 text-left transition-colors hover:bg-gray-50 ${
                          selected
                            ? "border-primary-700 ring-1 ring-primary-700"
                            : "border-gray-200"
                        }`}
                      >
                        <NearbyNumber number={numbers[nearby.id]!} place={nearby} />
                        <span className="flex min-w-0 flex-col">
                          <span className="font-semibold text-gray-900">{nearby.name}</span>
                          <span className="text-[13px] text-gray-500">
                            {[categoryName(nearby.category), distance(nearby)]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                          {nearby.note && (
                            <span className="pt-1 text-sm text-gray-700">{nearby.note}</span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        )}
      </main>
      <BookingFooter />
    </div>
  );
}
