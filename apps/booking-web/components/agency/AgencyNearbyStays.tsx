"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import GuestMap, { MapGate, type GuestMapPlace } from "@/components/booking/GuestMap";
import { useWideScreen } from "@/components/booking/AccommodationViews";
import { formatDistance } from "@/components/booking/RoomPlace";
import { useCurrency } from "@/contexts/CurrencyContext";
import { chooseMaps, mapsChosen } from "@/lib/mapsChoice";
import { nearbyStays, stayHref, stayTypeName } from "@/lib/agencyOverview";
import {
  getAgencyStayPrices,
  type AgencyPage,
  type AgencySearch,
  type AgencyStay,
  type AgencyStayPrice,
} from "@/services/api/agencyPage";

/** Whole units, the guest's display currency first, as the agency's pins say a price. */
const usePriceLabel = () => {
  const { approximate } = useCurrency();
  return (price: AgencyStayPrice | undefined) => {
    const amount = price?.status === "available" ? price.price : null;
    return amount
      ? (approximate(amount.nightly, amount.currency) ??
          new Intl.NumberFormat("en-GB", {
            style: "currency",
            currency: amount.currency,
            maximumFractionDigits: 0,
          }).format(amount.nightly))
      : null;
  };
};

/**
 * Below a stay's rooms on its agency page (VAY-2461, Timo's prototype): "Other stays nearby", up
 * to 8 of the page's other stays, closest first, in one row that scrolls sideways, each with its
 * type, distance and from-price for the search; and a map with this stay as a dark pin and the
 * others with their prices. A card and its pin light up together; a card or a pin opens that
 * stay's page. Google loads only after the guest's "Show map" (VAY-2216). Each part shows only
 * when the agency switched it on.
 */
export default function AgencyNearbyStays({
  agency,
  stay,
  search,
  mapsKey,
}: {
  agency: AgencyPage;
  stay: AgencyStay;
  search: AgencySearch;
  mapsKey: string;
}) {
  const t = useTranslations("agency");
  const locale = useLocale();
  const priceLabel = usePriceLabel();
  const nearby = agency.stayPage.nearby ? nearbyStays(agency.stays, stay) : [];
  const showMap =
    agency.stayPage.map && !!mapsKey && [stay, ...nearby.map((one) => one.stay)].some((s) => s.map);
  const [hovered, setHovered] = useState<string | null>(null);
  const wide = useWideScreen();
  const [requested, setRequested] = useState(mapsChosen);

  // The nearby stays' prices for the same search: the agency's read, as on its overview.
  const searchKey = JSON.stringify(search);
  const [prices, setPrices] = useState<{ key: string; byId: Map<string, AgencyStayPrice> } | null>(
    null,
  );
  const wanted = nearby.length > 0;
  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    getAgencyStayPrices(agency.slug, JSON.parse(searchKey) as AgencySearch, controller.signal)
      .then((answer) =>
        setPrices({
          key: searchKey,
          byId: new Map(answer.stays.map((price) => [price.propertyId, price])),
        }),
      )
      // Without prices the stays are still listed.
      .catch(() => undefined);
    return () => controller.abort();
  }, [agency.slug, searchKey, wanted]);
  const priceOf = (one: AgencyStay) =>
    prices?.key === searchKey ? prices.byId.get(one.propertyId) : undefined;

  if (!nearby.length && !showMap) return null;
  const location =
    typeof window === "undefined"
      ? { protocol: "https:", host: "", pathname: "/" }
      : window.location;
  const hrefOf = (one: AgencyStay) => {
    const price = priceOf(one);
    return stayHref(
      location,
      agency.slug,
      one.slug,
      search,
      price ? { rooms: price.rooms, promoApplied: !!price.price?.promoApplied } : null,
    );
  };
  const distance = (one: (typeof nearby)[number]) =>
    one.metres === null
      ? null
      : t(one.approximate ? "aboutAway" : "distanceAway", {
          distance: formatDistance(one.metres, locale, one.approximate),
        });

  // This stay first (its pin is the dark one), then the others with a pin.
  const pinned = [stay, ...nearby.map((one) => one.stay)].filter((one) => one.map);
  const places: GuestMapPlace[] = pinned.map((one) => {
    const price = one.slug === stay.slug ? null : priceLabel(priceOf(one));
    return {
      key: one.propertyId,
      label:
        one.slug === stay.slug
          ? one.name
          : price
            ? hovered === one.propertyId
              ? `${one.name} · ${price}`
              : price
            : one.name,
      latitude: one.map!.latitude,
      longitude: one.map!.longitude,
      approximate: one.map!.approximate,
      name: price ? t("pinName", { name: one.name, amount: price }) : one.name,
    };
  });
  const indexOf = (propertyId: string | null) =>
    pinned.findIndex((one) => one.propertyId === propertyId);

  return (
    <section
      // Named by its heading; the map alone is a region of its own.
      aria-labelledby={nearby.length > 0 ? "nearby-heading" : undefined}
      data-testid="agency-nearby"
      className="mx-auto flex max-w-7xl flex-col gap-3.5 px-4 pb-28 sm:px-6 lg:px-8"
    >
      <div className="flex flex-col gap-3.5 border-t border-gray-200 pt-7">
        {nearby.length > 0 && (
          <>
            <h2 id="nearby-heading" className="font-heading text-[22px] text-gray-900 lg:text-3xl">
              {t("nearbyHeading")}
            </h2>
            <p className="-mt-1.5 text-[15px] text-gray-500">
              {/* A phone has no mouse to point at a stay with (VAY-2463). */}
              {t(showMap && wide ? "nearbyHintMap" : "nearbyHint")}
            </p>
            <ul
              data-testid="agency-nearby-stays"
              className="flex snap-x snap-mandatory gap-[18px] overflow-x-auto pb-2.5"
            >
              {nearby.map((one) => {
                const price = priceOf(one.stay);
                const amount = priceLabel(price);
                const away = distance(one);
                const lit = hovered === one.stay.propertyId;
                return (
                  <li
                    key={one.stay.propertyId}
                    className="w-[200px] shrink-0 snap-start lg:w-[260px]"
                  >
                    <a
                      href={hrefOf(one.stay)}
                      data-testid={`agency-nearby-${one.stay.slug}`}
                      data-highlighted={lit || undefined}
                      onMouseEnter={() => setHovered(one.stay.propertyId)}
                      onMouseLeave={() =>
                        setHovered((current) => (current === one.stay.propertyId ? null : current))
                      }
                      onFocus={() => setHovered(one.stay.propertyId)}
                      onBlur={() =>
                        setHovered((current) => (current === one.stay.propertyId ? null : current))
                      }
                      className={`flex h-full flex-col overflow-hidden rounded-[18px] border bg-white text-gray-900 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 ${
                        lit ? "border-gray-900" : "border-gray-200 hover:border-gray-900"
                      }`}
                    >
                      <span className="relative block aspect-[4/3] w-full bg-gray-200">
                        {one.stay.photoUrl && (
                          <Image
                            src={one.stay.photoUrl}
                            alt=""
                            fill
                            sizes="260px"
                            className="object-cover"
                          />
                        )}
                      </span>
                      <span className="flex flex-col gap-0.5 px-4 pb-4 pt-3">
                        <strong className="text-[17px]">{one.stay.name}</strong>
                        <span className="text-sm text-gray-500">
                          {[one.stay.propertyType && stayTypeName(one.stay.propertyType, t), away]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        <span className="mt-1 text-sm text-gray-500">
                          {amount
                            ? t.rich("fromNight", {
                                amount,
                                strong: (chunks) => (
                                  <strong className="text-lg text-gray-900">{chunks}</strong>
                                ),
                              })
                            : price && price.status !== "available" && price.status !== "unknown"
                              ? t("notAvailable")
                              : null}
                        </span>
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {showMap && (
          <div
            id="stay-map"
            data-testid="agency-stay-map"
            className="relative mt-2 h-[240px] scroll-mt-4 overflow-hidden rounded-[20px] border border-gray-200 bg-gray-100 lg:h-[420px] lg:scroll-mt-36"
          >
            {requested ? (
              <GuestMap
                places={places}
                selected={indexOf(stay.propertyId) < 0 ? null : indexOf(stay.propertyId)}
                onSelect={(index) => {
                  const one = pinned[index];
                  if (one && one.slug !== stay.slug) window.location.assign(hrefOf(one));
                }}
                highlighted={indexOf(hovered) < 0 ? null : indexOf(hovered)}
                onHover={(index) => {
                  const one = index === null ? null : pinned[index];
                  setHovered(one && one.slug !== stay.slug ? one.propertyId : null);
                }}
                apiKey={mapsKey}
                label={t("stayMapLabel")}
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
        )}
      </div>
    </section>
  );
}
