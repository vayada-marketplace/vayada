"use client";

import { useTranslations } from "next-intl";

interface RateOptionProps {
  rateType: "flexible" | "nonrefundable";
  selected: boolean;
  onSelect: () => void;
  /** Renders the leading icon — the no-refund X for non-refundable, the refresh arrow for flexible. */
  iconType: "flexible" | "nonrefundable";
  title: string;
  description: string;
  /** Already-formatted total + per-night strings so the parent owns currency formatting. */
  totalLabel: string;
  nightlyLabel: string;
  /** Optional `-X% OFF` badge next to the title. */
  discountPercent?: number;
  soldOut: boolean;
}

export default function RateOption({
  rateType,
  selected,
  onSelect,
  iconType,
  title,
  description,
  totalLabel,
  nightlyLabel,
  discountPercent,
  soldOut,
}: RateOptionProps) {
  const t = useTranslations("home");

  return (
    <button
      onClick={onSelect}
      disabled={soldOut}
      data-rate-type={rateType}
      className={`w-full text-left rounded-xl border-2 p-4 transition-colors disabled:cursor-not-allowed ${soldOut ? "opacity-50" : ""} ${selected ? "border-primary-500" : "border-gray-200 hover:border-gray-300"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          {iconType === "nonrefundable" ? (
            <svg
              className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          ) : (
            <svg
              className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          )}
          <div className="min-w-0">
            <p className="text-sm font-bold text-gray-900 flex items-center gap-2 flex-wrap">
              <span className="break-words">{title}</span>
              {discountPercent != null && discountPercent > 0 && (
                <span className="text-[10px] font-bold bg-primary-600 text-white px-1.5 py-0.5 rounded whitespace-nowrap">
                  -{discountPercent}% OFF
                </span>
              )}
            </p>
            <p className="text-xs text-gray-500">{description}</p>
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-base md:text-lg font-bold text-gray-900 whitespace-nowrap">
            {totalLabel}
          </p>
          <p className="text-xs text-gray-500 whitespace-nowrap">
            {t("perNightly", { price: nightlyLabel })}
          </p>
        </div>
      </div>
    </button>
  );
}
