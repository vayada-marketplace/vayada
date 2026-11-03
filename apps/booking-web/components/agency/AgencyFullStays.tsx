"use client";

import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { formatStayRange } from "@/lib/agencyOverview";
import type { AgencyStay, AgencyStayPrice } from "@/services/api/agencyPage";

/**
 * The stays that can't take this search, after the cards (VAY-2459, when the agency shows full
 * stays): each with its next free dates of the same length, which "Use these dates" searches.
 */
export default function AgencyFullStays({
  dates,
  stays,
  tooSmall,
  onUse,
}: {
  dates: string;
  stays: { stay: AgencyStay; price: AgencyStayPrice }[];
  tooSmall: (price: AgencyStayPrice) => string;
  onUse: (dates: { checkIn: string; checkOut: string }) => void;
}) {
  const t = useTranslations("agency");
  const locale = useLocale();
  return (
    <section
      aria-labelledby="full-stays-heading"
      data-testid="agency-full-stays"
      className="mt-10 flex flex-col gap-3 border-t border-gray-200 pt-5"
    >
      <h3 id="full-stays-heading" className="text-lg font-bold text-gray-900">
        {t("fullHeading", { dates, count: stays.length })}
      </h3>
      <ul className="flex flex-col gap-3">
        {stays.map(({ stay, price }) => {
          const next = price.status === "unavailable" ? price.nextFree : null;
          return (
            <li
              key={stay.propertyId}
              data-testid={`agency-full-${stay.slug}`}
              className="flex flex-wrap items-center gap-4 rounded-2xl border border-gray-200 p-3"
            >
              <div className="relative h-[66px] w-[88px] shrink-0 overflow-hidden rounded-[10px] bg-gray-200">
                {stay.photoUrl && (
                  <Image
                    src={stay.photoUrl}
                    alt=""
                    fill
                    sizes="88px"
                    className="object-cover opacity-70 grayscale"
                  />
                )}
              </div>
              <div className="flex min-w-[12rem] flex-[1_1_200px] flex-col gap-0.5">
                <span className="text-[17px] font-bold text-gray-500">{stay.name}</span>
                <span className="text-sm text-gray-500">
                  {price.status === "no_fit"
                    ? tooSmall(price)
                    : next
                      ? t("nextFree", {
                          dates: formatStayRange(next.checkIn, next.checkOut, locale),
                        })
                      : t("noNextFree")}
                </span>
              </div>
              {next && (
                <button
                  type="button"
                  onClick={() => onUse(next)}
                  aria-label={`${t("useDates")}: ${stay.name}`}
                  className="min-h-[44px] px-1 text-[15px] font-semibold text-gray-900 underline hover:text-black"
                >
                  {t("useDates")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
