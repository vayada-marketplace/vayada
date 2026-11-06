"use client";

import { useState } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import type { AccountBookingPageLayout } from "@vayada/domain-booking/account-booking-page";
import GuestMap, { MapGate, type GuestMapPlace } from "@/components/booking/GuestMap";
import { chooseMaps, mapsChosen } from "@/lib/mapsChoice";
import type { AgencyCard } from "@/lib/agencyOverview";
import type { AgencyStay } from "@/services/api/agencyPage";

/** Room around the pills on the phone's map: its summary above, the stay's card and List below. */
const PHONE_FIT = { top: 96, right: 48, bottom: 240, left: 48 };

/** The agency overview's layouts (VAY-2460), as Settings names them. */
const LAYOUTS: Record<AccountBookingPageLayout, "viewList" | "viewSplit" | "viewMap"> = {
  list: "viewList",
  split: "viewSplit",
  map: "viewMap",
};

/** List, List + map and Map, as in Timo's prototype: only the layouts the agency allows. */
export function AgencyLayoutSwitch({
  layouts,
  layout,
  onChange,
}: {
  layouts: AccountBookingPageLayout[];
  layout: AccountBookingPageLayout;
  onChange: (layout: AccountBookingPageLayout) => void;
}) {
  const t = useTranslations("locationMap");
  return (
    <div
      role="group"
      aria-label={t("viewsLabel")}
      className="ml-auto flex rounded-full border border-gray-200 bg-gray-100 p-1"
    >
      {layouts.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={layout === value}
          onClick={() => onChange(value)}
          className={`inline-flex min-h-[40px] items-center gap-2 rounded-full px-4 text-[15px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
            layout === value
              ? "bg-white text-gray-900 shadow-[0_1px_3px_rgba(0,0,0,0.12)]"
              : "text-gray-500 hover:text-gray-900"
          }`}
        >
          <LayoutIcon layout={value} />
          {t(LAYOUTS[value])}
        </button>
      ))}
    </div>
  );
}

function LayoutIcon({ layout }: { layout: AccountBookingPageLayout }) {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={layout === "list" ? 2 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {layout === "list" ? (
        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
      ) : layout === "split" ? (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M12 4v16" />
        </>
      ) : (
        <>
          <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" />
          <path d="M9 4v14M15 6v14" />
        </>
      )}
    </svg>
  );
}

/**
 * The stays on a map (VAY-2460), for List + map and Map: one pill per shown stay at its pin
 * (an area for an approximate one) with its from-price, the stay under the mouse stands out on
 * both sides, and a pill opens the stay's small card with View rooms. Stays without a pin stay
 * off the map. Google loads only after the guest's "Show map" (VAY-2216), remembered for the tab.
 * The map is drawn once for every stay with a pin: filters, sorting and new prices only hide pills
 * or change their labels, so the guest's view stays and no new map is loaded. On a phone
 * (`phone`, VAY-2463) it fills the screen: one finger moves it, and the stay's card sits above
 * the List button with View rooms under it.
 */
export default function AgencyStayMap({
  stays,
  cards,
  apiKey,
  hovered,
  onHover,
  picked,
  onPick,
  price,
  typeName,
  href,
  compact = false,
  phone = false,
  className = "",
}: {
  /** All the page's stays, in its order. */
  stays: AgencyStay[];
  /** The stays shown, in the guest's order. */
  cards: AgencyCard[];
  apiKey: string;
  hovered: string | null;
  onHover: (propertyId: string | null) => void;
  /** The stay whose pill was clicked; null closes its card. */
  picked: string | null;
  onPick: (propertyId: string | null) => void;
  /** The stay's from-price per night as its pill says it; null without one. */
  price: (card: AgencyCard) => string | null;
  typeName: (card: AgencyCard) => string | null;
  href: (card: AgencyCard) => string;
  /** A narrow map (beside the list): the stay's card puts View rooms under its name. */
  compact?: boolean;
  /** The phone's full-screen map (AgencyPhoneMap): no frame, its summary on top, List below. */
  phone?: boolean;
  className?: string;
}) {
  const t = useTranslations("agency");
  const tc = useTranslations("common");
  const [requested, setRequested] = useState(mapsChosen);
  const pinned = stays.filter((stay) => stay.map);
  const cardOf = (propertyId: string | null) =>
    cards.find((card) => card.stay.propertyId === propertyId) ?? null;
  const places: GuestMapPlace[] = pinned.map((stay) => {
    const card = cardOf(stay.propertyId);
    const amount = card && price(card);
    return {
      key: stay.propertyId,
      label: amount ?? stay.name,
      latitude: stay.map!.latitude,
      longitude: stay.map!.longitude,
      approximate: stay.map!.approximate,
      name: amount ? t("pinName", { name: stay.name, amount }) : stay.name,
    };
  });
  const hidden = pinned.flatMap((stay) => (cardOf(stay.propertyId) ? [] : [stay.propertyId]));
  // A shown stay's place on the map, -1 when it has none (or isn't shown).
  const at = (propertyId: string | null) =>
    cardOf(propertyId) ? pinned.findIndex((stay) => stay.propertyId === propertyId) : -1;
  const chosen = at(picked) >= 0 ? cardOf(picked) : null;
  const facts = chosen && [
    typeName(chosen),
    price(chosen) && t("fromPerNight", { amount: price(chosen)! }),
  ];

  return (
    <div
      data-testid="agency-map"
      onKeyDown={(event) => {
        // The phone's map closes a card itself, wherever the focus is (AgencyPhoneMap).
        if (event.key === "Escape" && chosen && !phone) onPick(null);
      }}
      className={`relative overflow-hidden bg-gray-100 ${
        phone ? "" : "rounded-[20px] border border-gray-200"
      } ${className}`}
    >
      {!requested ? (
        <MapGate
          className="h-full"
          onRequest={() => {
            chooseMaps();
            setRequested(true);
          }}
        />
      ) : pinned.length === 0 ? (
        <p className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-500">
          {t("noMapStays")}
        </p>
      ) : (
        <>
          <GuestMap
            places={places}
            hidden={hidden}
            selected={at(picked) < 0 ? null : at(picked)}
            onSelect={(index) => onPick(pinned[index]!.propertyId)}
            highlighted={at(hovered) < 0 ? null : at(hovered)}
            onHover={(index) => onHover(index === null ? null : pinned[index]!.propertyId)}
            apiKey={apiKey}
            label={t("mapLabel")}
            className="h-full"
            {...(phone ? { gestureHandling: "greedy" as const, fitPadding: PHONE_FIT } : {})}
          />
          {hidden.length === pinned.length && (
            <p
              className={`absolute inset-x-4 z-10 rounded-xl ${phone ? "top-24" : "top-4"} bg-white px-4 py-3 text-center text-sm text-gray-600 shadow-[0_2px_8px_rgba(0,0,0,0.12)]`}
            >
              {t("noMapStays")}
            </p>
          )}
        </>
      )}
      {requested && chosen && (
        // Above Google's logo and terms at the bottom of the map.
        <div
          data-testid="agency-map-card"
          className={`absolute left-4 right-4 z-10 flex gap-3.5 rounded-2xl bg-white p-3 shadow-[0_8px_24px_rgba(0,0,0,0.16)] ${
            phone
              ? "bottom-[6.5rem] flex-col"
              : compact
                ? "bottom-10 flex-col"
                : "bottom-10 items-center"
          }`}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3.5">
            <div
              className={`relative shrink-0 overflow-hidden rounded-[10px] bg-gray-200 ${
                compact ? "h-[60px] w-[80px]" : "h-[78px] w-[104px]"
              }`}
            >
              {chosen.stay.photoUrl && (
                <Image
                  src={chosen.stay.photoUrl}
                  alt={chosen.stay.name}
                  fill
                  sizes="104px"
                  className="object-cover"
                />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 pr-4">
              <span className="line-clamp-2 text-[17px] font-bold leading-snug text-gray-900">
                {chosen.stay.name}
              </span>
              <span className="text-sm text-gray-500">{facts!.filter(Boolean).join(" · ")}</span>
            </div>
          </div>
          <a
            href={href(chosen)}
            className="shrink-0 rounded-full bg-primary-600 px-5 py-3 text-center text-[15px] font-semibold text-primary-on-600 hover:bg-primary-700"
          >
            {t("viewRooms")}
          </a>
          <button
            type="button"
            onClick={() => onPick(null)}
            aria-label={tc("close")}
            // A touch target of at least 44 px around the small round button.
            className="absolute -right-2 -top-2 flex h-8 w-8 items-center justify-center rounded-full bg-white text-gray-700 shadow-[0_2px_6px_rgba(0,0,0,0.2)] before:absolute before:-inset-1.5 before:content-[''] hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
