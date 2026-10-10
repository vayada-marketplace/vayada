"use client";

import { useTranslations } from "next-intl";
import { useCurrency } from "@/contexts/CurrencyContext";

/** Explains "≈" figures wherever they appear: the booking is charged in its own currency. */
export default function ApproximateAmountsNote({ currency }: { currency: string }) {
  const t = useTranslations("common");
  const { approximate, attribution } = useCurrency();
  if (!approximate(1, currency)) return null;
  return (
    <p className="text-xs text-gray-500" data-testid="approximate-amounts-note">
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
