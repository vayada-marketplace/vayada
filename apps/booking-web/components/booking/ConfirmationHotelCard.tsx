"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import HotelHeroImage from "@/components/booking/HotelHeroImage";
import { Link } from "@/i18n/navigation";
import { bookingImageSizes } from "@/components/booking/imageSizes";
import { placeAddress, placeDirectionsUrl, type StayPlace } from "@/lib/bookingStay";

/** A small drawn map with a pin: no Google request before the guest asks for a map (VAY-2216). */
function MapTile() {
  return (
    <span
      aria-hidden="true"
      className="flex h-11 w-[52px] shrink-0 overflow-hidden rounded-[10px] border border-gray-200 bg-[#EEF2EA]"
    >
      <svg viewBox="0 0 52 44" width="52" height="44">
        <path d="M0 14H52M0 30H52M17 0V44M35 0V44" stroke="#D9E1D3" strokeWidth="1" />
        <path d="M0 36C14 31 30 40 52 33" stroke="#FFFFFF" strokeWidth="3" fill="none" />
        <path
          d="M26 10c-4 0-7 3-7 7 0 5 7 12 7 12s7-7 7-12c0-4-3-7-7-7Z"
          className="fill-primary-700"
        />
        <circle cx="26" cy="17" r="2.4" fill="#FFFFFF" />
      </svg>
    </span>
  );
}

const DIRECTIONS =
  "flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-primary-700 px-4 font-semibold text-white transition-colors hover:bg-primary-800";
const NAV_ICON = (
  <svg
    aria-hidden="true"
    className="h-4 w-4 shrink-0"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    viewBox="0 0 24 24"
  >
    <path d="m3 11 19-9-9 19-2-8-8-2z" />
  </svg>
);

/** VAY-2360: the hotel card on the confirmation page: photo, name, the address on one line, a drawn map,
 * Directions and a copy-address button. A confirmed stay shows its exact place (as its email does); otherwise
 * the hotel's public area and pin. Rooms elsewhere get a line each with their own address and directions. */
export default function ConfirmationHotelCard({
  name,
  heroImage,
  places,
  fallback,
  aroundHref,
}: {
  name: string;
  heroImage: string | null;
  places: StayPlace[];
  /** "Around {hotel}" when the hotel has local tips; without them Directions opens Google Maps (D6). */
  aroundHref?: string;
  /** The hotel's public area and its Directions link, for stays without exact places. */
  fallback: { address: string | null; directionsUrl: string | null };
}) {
  const t = useTranslations("confirmation");
  const locale = useLocale();
  const [copied, setCopied] = useState(false);
  const [first, ...others] = places;
  const address = first ? placeAddress(first, locale) : fallback.address;
  const directions = first ? placeDirectionsUrl(first, address) : fallback.directionsUrl;
  const copy = () => {
    if (!address) return;
    void navigator.clipboard
      ?.writeText(address)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // The address stays on screen to copy by hand.
      });
  };
  return (
    <div
      className="overflow-hidden rounded-2xl border border-gray-200 bg-white lg:rounded-[20px]"
      data-testid="confirmation-hotel"
    >
      <div className="relative aspect-[2/1] sm:aspect-[32/15]">
        <HotelHeroImage src={heroImage} alt={name} sizes={bookingImageSizes.confirmationHotel} />
      </div>
      <div className="flex flex-col gap-0.5 px-[18px] pb-[18px] pt-3.5">
        <p className="font-heading text-[22px] font-semibold leading-7 text-gray-900">{name}</p>
        {address && <p className="truncate text-sm text-gray-600">{address}</p>}
        {(directions || aroundHref || address) && (
          <div className="flex items-center gap-2.5 pt-2">
            {(directions || aroundHref) && <MapTile />}
            {aroundHref ? (
              <Link href={aroundHref} className={DIRECTIONS}>
                {NAV_ICON}
                {t("directions")}
              </Link>
            ) : (
              directions && (
                <a
                  href={directions}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t("directionsLabel", { place: name })}
                  className={DIRECTIONS}
                >
                  {NAV_ICON}
                  {t("directions")}
                </a>
              )
            )}
            {address && (
              <button
                type="button"
                onClick={copy}
                aria-label={copied ? t("addressCopied") : t("copyAddress")}
                title={t("copyAddress")}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-gray-300 text-gray-700 transition-colors hover:bg-gray-50"
              >
                <svg
                  aria-hidden="true"
                  className="h-[18px] w-[18px]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  viewBox="0 0 24 24"
                >
                  {copied ? (
                    <path d="m4.5 12.75 6 6 9-13.5" />
                  ) : (
                    <>
                      <rect x="9" y="9" width="12" height="12" rx="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </>
                  )}
                </svg>
              </button>
            )}
          </div>
        )}
        {others.map((place, index) => {
          const elsewhere = placeAddress(place, locale);
          const link = placeDirectionsUrl(place, elsewhere);
          return (
            <p key={index} className="pt-2 text-sm text-gray-600">
              <span className="font-semibold text-gray-900">{place.rooms.join(", ")}</span>
              {elsewhere ? ` · ${elsewhere}` : ""}
              {link && (
                <>
                  {" · "}
                  <a
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-primary-700 underline"
                  >
                    {t("directions")}
                  </a>
                </>
              )}
            </p>
          );
        })}
      </div>
    </div>
  );
}
