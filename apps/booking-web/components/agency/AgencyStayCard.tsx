"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { useCurrency } from "@/contexts/CurrencyContext";
import type { AgencyCard } from "@/lib/agencyOverview";

export type AgencyCardText = {
  /** What is free for the search, for an available stay. */
  facts: (card: AgencyCard) => string;
  href: (card: AgencyCard) => string;
};

const KNOWN_TYPES = [
  "hotel",
  "resort",
  "hostel",
  "apartment",
  "aparthotel",
  "guesthouse",
  "bed_and_breakfast",
  "homestay",
  "villa",
  "vacation_rental",
  "motel",
  "other",
];

/** The charged amount in its own currency, with cents when it has them (as on room cards). */
const exactMoney = (value: number, currency: string) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);

/**
 * One stay on the agency overview (VAY-2459): its photo with its type and the "Lowest price"
 * badge, its name and area, what is free for the search, its lowest price per night and in
 * total, and a link to its own page. The guest's display currency leads, as on room cards.
 */
export default function AgencyStayCard({
  card,
  text,
  loading,
}: {
  card: AgencyCard;
  text: AgencyCardText;
  loading: boolean;
}) {
  const t = useTranslations("agency");
  const { approximate } = useCurrency();
  const { stay, price, lowest } = card;
  const money = (value: number, currency: string) =>
    approximate(value, currency) ?? exactMoney(value, currency);
  const type = stay.propertyType
    ? KNOWN_TYPES.includes(stay.propertyType)
      ? t(`type.${stay.propertyType}`)
      : stay.propertyType
    : null;
  const priced = price?.status === "available" ? price.price : null;

  return (
    <li className="min-w-0">
      <a
        href={text.href(card)}
        data-testid={`agency-stay-${stay.slug}`}
        className="group flex h-full flex-col overflow-hidden rounded-[20px] border border-gray-200 bg-white text-gray-900 transition hover:border-gray-900 hover:shadow-[0_8px_24px_rgba(0,0,0,0.12)] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
      >
        <div className="relative aspect-[4/3] w-full bg-gray-200">
          {stay.photoUrl && (
            <Image
              src={stay.photoUrl}
              alt={stay.name}
              fill
              sizes="(min-width: 1280px) 320px, (min-width: 640px) 50vw, 100vw"
              className="object-cover"
            />
          )}
          {type && (
            <span className="absolute left-3.5 top-3.5 rounded-full bg-white px-2.5 py-0.5 text-[13px] font-semibold text-gray-900">
              {type}
            </span>
          )}
          {lowest && (
            <span className="absolute right-3.5 top-3.5 rounded-full bg-primary-600 px-2.5 py-0.5 text-[13px] font-semibold text-white">
              {t("lowestPrice")}
            </span>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-1.5 px-[18px] pb-[18px] pt-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 text-[19px] font-bold leading-snug">{stay.name}</span>
            {stay.area && (
              <span className="shrink-0 whitespace-nowrap text-sm text-gray-500">{stay.area}</span>
            )}
          </div>
          {loading ? (
            <span aria-hidden="true" className="h-4 w-44 animate-pulse rounded bg-gray-200" />
          ) : (
            price &&
            price.status === "available" && (
              <span className="text-sm text-gray-500">{text.facts(card)}</span>
            )
          )}
          <div className="mt-auto flex items-end justify-between gap-2 pt-2">
            {loading ? (
              <span aria-hidden="true" className="flex flex-col gap-1.5">
                <span className="h-6 w-32 animate-pulse rounded bg-gray-200" />
                <span className="h-4 w-24 animate-pulse rounded bg-gray-200" />
              </span>
            ) : priced ? (
              <span className="flex flex-col text-sm text-gray-500">
                <span>
                  {t.rich("fromNight", {
                    amount: money(priced.nightly, priced.currency),
                    strong: (chunks) => (
                      <strong className="text-[21px] text-gray-900">{chunks}</strong>
                    ),
                  })}
                </span>
                <span>{t("fromTotal", { price: money(priced.total, priced.currency) })}</span>
              </span>
            ) : (
              <span className="text-sm text-gray-500">{price ? t("noPrice") : null}</span>
            )}
            <span className="shrink-0 text-[15px] font-semibold underline">{t("viewRooms")}</span>
          </div>
        </div>
      </a>
    </li>
  );
}
