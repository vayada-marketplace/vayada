"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { metresBetween, type LocationMapPin, type NearbyCategoryView } from "@vayada/domain-hotels";
import { NearbyCategoryBadge } from "@vayada/product-onboarding/NearbyCategoryBadge";
import { NEARBY_CATEGORY_HEX } from "@vayada/product-onboarding/nearbyPlaces";
import {
  directionsUrl,
  fetchGuestNearby,
  hiddenNearbyCategories,
  hideNearbyCategories,
  type GuestNearby,
  type GuestNearbyPlace,
} from "@/lib/nearbyPlaces";
import type { GuestMapPlace } from "./GuestMap";
import { formatDistance } from "./RoomPlace";

/** Where a place's distance is measured from (VAY-2327): the selected accommodation's place, the main house, or
 * the property when every room is there. */
export type NearbyReference = {
  latitude: number;
  longitude: number;
  /** Rounded to an area: the distance reads "about". */
  approximate: boolean;
} & ({ kind: "mainHouse" } | { kind: "property" } | { kind: "place"; label: string });

/** The host's nearby places on a guest map (VAY-2327): loaded once the guest asked for the map (VAY-2216), with
 * the categories the guest turned off (for this tab) and the selected place. */
export function useNearbyLayer(slug: string | null | undefined, active: boolean) {
  const [nearby, setNearby] = useState<GuestNearby>({ places: [], categories: [] });
  const [hidden, setHidden] = useState<string[]>(hiddenNearbyCategories);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!active || !slug) return;
    const controller = new AbortController();
    fetchGuestNearby(slug, controller.signal)
      .then(setNearby)
      // Without them the map works as before: nearby places are extra.
      .catch(() => undefined);
    return () => controller.abort();
  }, [active, slug]);
  const visible = nearby.places.filter(({ category }) => !hidden.includes(category.id));
  return {
    categories: nearby.categories,
    hidden,
    visible,
    selected: visible.find(({ id }) => id === selectedId) ?? null,
    select: setSelectedId,
    close: () => setSelectedId(null),
    toggle: (id: string) => {
      const next = hidden.includes(id) ? hidden.filter((other) => other !== id) : [...hidden, id];
      setHidden(next);
      hideNearbyCategories(next);
    },
  };
}
export type NearbyLayer = ReturnType<typeof useNearbyLayer>;

export function useNearbyCategoryName() {
  const t = useTranslations("nearbyMap");
  return (category: NearbyCategoryView) => category.name ?? t(`category.${category.id}`);
}

/** One chip per category the places use, custom ones too, turning its places on or off at once. */
export function NearbyChips({ layer, className = "" }: { layer: NearbyLayer; className?: string }) {
  const t = useTranslations("nearbyMap");
  const name = useNearbyCategoryName();
  if (layer.categories.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={t("filtersLabel")}
      className={`flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}
    >
      {layer.categories.map((category) => {
        const on = !layer.hidden.includes(category.id);
        return (
          <button
            key={category.id}
            type="button"
            aria-pressed={on}
            onClick={() => {
              if (on && layer.selected?.category.id === category.id) layer.close();
              layer.toggle(category.id);
            }}
            className={`inline-flex min-h-[36px] shrink-0 items-center gap-2 rounded-full border bg-white px-3 text-[13px] font-semibold shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
              on ? "border-gray-200 text-gray-900" : "border-gray-200 text-gray-400"
            }`}
          >
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: on ? NEARBY_CATEGORY_HEX[category.color] : "#D1D5DB" }}
            />
            {name(category)}
          </button>
        );
      })}
    </div>
  );
}

/** The selected place: its name, category and distance, the host's tip and Directions. Close or Escape dismisses
 * it, and the focus moves into it when it opens. */
export function NearbyPlaceCard({
  place,
  reference,
  onClose,
  className = "",
}: {
  place: GuestNearbyPlace;
  reference: NearbyReference | null;
  onClose: () => void;
  className?: string;
}) {
  const t = useTranslations("nearbyMap");
  const locale = useLocale();
  const name = useNearbyCategoryName();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, [place.id]);
  const distance =
    reference && formatDistance(metresBetween(place, reference), locale, reference.approximate);
  // Measured from or to a rounded spot: "about", in whole kilometres.
  const about = reference?.approximate ? "About" : "";
  const from =
    distance &&
    (reference.kind === "place"
      ? t(`fromPlace${about}`, { distance, place: reference.label })
      : t(`${reference.kind === "property" ? "fromProperty" : "fromMainHouse"}${about}`, {
          distance,
        }));
  return (
    <section
      aria-label={place.name}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
      className={`rounded-2xl border-t-4 bg-white p-4 shadow-xl ${className}`}
      style={{ borderTopColor: NEARBY_CATEGORY_HEX[place.category.color] }}
      data-testid="nearby-place-card"
    >
      <div className="flex items-center gap-3">
        <NearbyCategoryBadge category={place.category} size={36} />
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-base font-bold leading-snug text-gray-900">
            {place.name}
          </h3>
          <p className="text-[13px] text-gray-500">
            {[name(place.category), from].filter(Boolean).join(" · ")}
          </p>
        </div>
        <button
          ref={closeRef}
          type="button"
          aria-label={t("close")}
          onClick={onClose}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
      {place.note && (
        <div className="mt-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
            {t("hostTip")}
          </p>
          <p className="mt-0.5 break-words text-[15px] leading-snug text-gray-700">{place.note}</p>
        </div>
      )}
      <a
        href={directionsUrl(place)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t("directionsLabel", { name: place.name })}
        className="mt-3 inline-flex min-h-[44px] items-center gap-1.5 text-sm font-bold text-primary-600 hover:underline"
      >
        {t("directions")}
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
          />
        </svg>
      </a>
    </section>
  );
}

/** The nearby places a guest map draws: those of the categories the guest left on (VAY-2327). */
export function nearbyOnMap(nearby: NearbyLayer) {
  return { places: nearby.visible, selected: nearby.selected?.id ?? null, onSelect: nearby.select };
}

/** Closes the place's card and gives the focus back to its marker. */
export function closeNearby(nearby: NearbyLayer) {
  const id = nearby.selected?.id;
  nearby.close();
  if (id)
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-nearby-id="${CSS.escape(id)}"]`)?.focus(),
    );
}

/** Distances count from the selected accommodation's place; with none selected, from the main house. */
export function nearbyReference(
  pins: LocationMapPin[],
  places: GuestMapPlace[],
  selectedPin: number,
): NearbyReference | null {
  const index = selectedPin >= 0 ? selectedPin : pins.findIndex(({ kind }) => kind === "property");
  const pin = pins[index];
  if (!pin) return null;
  const at = { latitude: pin.latitude, longitude: pin.longitude, approximate: pin.approximate };
  return pin.kind === "property"
    ? { ...at, kind: "mainHouse" }
    : { ...at, kind: "place", label: places[index].label };
}
