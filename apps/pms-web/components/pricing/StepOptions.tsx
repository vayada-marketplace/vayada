"use client";

import type { ReactNode } from "react";
import { ArrowPathIcon, LockClosedIcon, PlusIcon } from "@heroicons/react/24/outline";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { mainOffer, money, optionSummary, type OptionTerms } from "./stepPricing";
import { StepCard } from "./StepCard";
import * as ui from "./pricingStyles";

type Offer = PricingConfiguration["offers"][number];
/** A cup, from the Paper design (Heroicons has none). */
const CupIcon = ({ className }: { className: string }) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z" />
    <path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17" />
    <path d="M8 3v3M12 3v3" />
  </svg>
);
const icon = (offer: Offer, terms: OptionTerms | undefined) => {
  const className = "h-5 w-5";
  if (offer.meal.kind !== "room_only") return <CupIcon className={className} />;
  return terms?.cancellation.kind === "non_refundable" ? (
    <LockClosedIcon aria-hidden="true" className={className} />
  ) : (
    <ArrowPathIcon aria-hidden="true" className={className} />
  );
};

/** Step 4: the room's booking options (offers) as named cards with a summary, their normal night and Edit, then the
 * add buttons. `prices` are engine-evaluated (see `normalNight`); null shows a dash. */
export function StepOptions({
  room,
  names,
  terms,
  prices,
  disabled,
  onEdit,
  add,
}: {
  room: PricingConfiguration;
  names: Readonly<Record<string, string>>;
  terms: Readonly<Record<string, OptionTerms | undefined>>;
  prices: Readonly<Record<string, string | null>>;
  disabled: boolean;
  onEdit: (offerId: string) => void;
  /** The quick-add buttons. */
  add: ReactNode;
}) {
  const { t } = useTranslation();
  const main = mainOffer(room);
  return (
    <StepCard
      number={4}
      title={t("pricing.steps.options.title")}
      hint={t("pricing.steps.options.hint")}
    >
      <ul className="space-y-2.5">
        {room.offers.map((offer) => {
          const isMain = offer.id === main.id,
            price = prices[offer.id];
          return (
            <li
              key={offer.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-gray-200 px-4 py-4 sm:flex-nowrap sm:px-[18px]"
            >
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] ${isMain ? "bg-primary-50 text-primary-600" : "bg-gray-100 text-gray-700"}`}
              >
                {icon(offer, terms[offer.id])}
              </span>
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-semibold leading-5 text-gray-900">
                    {names[offer.id]}
                  </span>
                  {isMain && (
                    <span className="rounded-md bg-gray-100 px-2 py-0.5 text-[12px] font-medium text-gray-500">
                      {t("pricing.steps.options.main")}
                    </span>
                  )}
                </div>
                <p className="text-[14px] leading-5 text-gray-500">
                  {optionSummary(room, offer, names, terms[offer.id], t)}
                </p>
              </div>
              <span className="ml-auto shrink-0 text-right text-[16px] font-semibold leading-5 text-gray-900 sm:ml-0 sm:w-[90px]">
                {price ? money(price, room.currency) : "—"}
                <span className="sr-only">
                  {" "}
                  {t(
                    room.capacity.adults === 1
                      ? "pricing.steps.options.priceNote.one"
                      : "pricing.steps.options.priceNote.other",
                    { count: Math.min(2, room.capacity.adults) },
                  )}
                </span>
              </span>
              <button
                type="button"
                aria-label={t("pricing.steps.options.editAria", { name: names[offer.id] })}
                disabled={disabled}
                onClick={() => onEdit(offer.id)}
                className={`shrink-0 text-right sm:w-[52px] ${ui.stepLink}`}
              >
                {t("pricing.steps.options.edit")}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[14px] text-gray-500">{t("pricing.steps.options.add")}</span>
        {add}
      </div>
    </StepCard>
  );
}

/** A dashed quick-add button ("+ Half board", "+ Own option"). */
export function AddOptionButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-9 items-center gap-1.5 rounded-full border border-dashed border-gray-400 px-3.5 text-[14px] text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <PlusIcon aria-hidden="true" className="h-3.5 w-3.5" /> {label}
    </button>
  );
}
