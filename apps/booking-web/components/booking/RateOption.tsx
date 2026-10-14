"use client";

import { useTranslations } from "next-intl";

/** One bookable choice on a room card, picked like a radio button. Restored from the old
 * booking page (VAY-2190): the cross marks no refund, the arrows a refundable choice. */
export default function RateOption({
  selected,
  onSelect,
  refundable,
  title,
  terms,
  totalLabel,
  nightlyLabel,
  discountPercent,
  unavailable,
  loading,
  disabled = false,
  publicOfferKey,
}: {
  selected: boolean;
  onSelect: () => void;
  refundable: boolean;
  title: string;
  terms: string;
  /** Formatted stay total and per-night price; null while prices load. */
  totalLabel: string | null;
  nightlyLabel: string | null;
  /** The `-X% OFF` badge next to a non-refundable choice. */
  discountPercent?: number;
  /** No price for this stay: shown, but can't be picked. */
  unavailable: boolean;
  /** Prices are on their way: show placeholders where they go. */
  loading: boolean;
  disabled?: boolean;
  publicOfferKey: string;
}) {
  const t = useTranslations("home");
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={unavailable || disabled}
      aria-pressed={selected}
      data-offer-key={publicOfferKey}
      className={`w-full text-left rounded-xl border-2 p-4 transition-colors disabled:cursor-not-allowed ${unavailable || disabled ? "opacity-50" : ""} ${selected ? "border-primary-500" : "border-gray-200 hover:border-gray-300"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <svg
            className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d={
                refundable
                  ? "M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  : "M6 18L18 6M6 6l12 12"
              }
            />
          </svg>
          <div className="min-w-0">
            <p className="text-sm font-bold text-gray-900 flex items-center gap-2 flex-wrap">
              <span className="break-words">{title}</span>
              {discountPercent != null && discountPercent > 0 && (
                <span className="text-[10px] font-bold bg-primary-600 text-white px-1.5 py-0.5 rounded whitespace-nowrap">
                  -{discountPercent}% OFF
                </span>
              )}
            </p>
            {terms && <p className="text-xs text-gray-500">{terms}</p>}
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          {unavailable ? (
            <p className="text-sm font-medium text-gray-500 whitespace-nowrap">
              {t("notAvailable")}
            </p>
          ) : totalLabel === null ? (
            loading && (
              <div className="space-y-1.5" aria-hidden="true">
                <div className="h-5 w-16 bg-gray-200 rounded animate-pulse ml-auto" />
                <div className="h-3 w-20 bg-gray-100 rounded animate-pulse ml-auto" />
              </div>
            )
          ) : (
            <>
              <p className="text-base md:text-lg font-bold text-gray-900 whitespace-nowrap">
                {totalLabel}
              </p>
              {nightlyLabel && (
                <p className="text-xs text-gray-500 whitespace-nowrap">
                  {t("perNightly", { price: nightlyLabel })}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </button>
  );
}
