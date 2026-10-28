"use client";

import { useTranslations } from "next-intl";
import { useCurrency } from "@/contexts/CurrencyContext";

/** Explains "≈" figures wherever they appear: the booking is charged in its own currency. */
export default function ApproximateAmountsNote({
  currency,
  className = "",
}: {
  currency: string;
  className?: string;
}) {
  const t = useTranslations("common");
  const { approximate, attribution } = useCurrency();
  // A large amount, so a currency worth far less than the guest's (LKR shown in USD) still
  // converts to at least one unit and the note shows.
  if (!approximate(1_000_000, currency)) return null;
  return (
    <p className={`text-xs text-gray-500 ${className}`} data-testid="approximate-amounts-note">
      {t("approximateAmounts", { currency })}
      {attribution && (
        <>
          {" "}
          <a
            href={attribution.url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-700"
          >
            {attribution.label}
          </a>
        </>
      )}
    </p>
  );
}
