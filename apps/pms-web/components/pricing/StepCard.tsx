"use client";

import { useId, type ReactNode } from "react";
import { useTranslation } from "@/lib/i18n";
import * as ui from "./pricingStyles";

/** One numbered question card (the first-price form), or, without `number`, one section of the simple Prices card
 * (VAY-2188): a title, "Optional" when it is, and a short hint. */
export function StepCard({
  number,
  title,
  hint,
  optional = false,
  children,
}: {
  number?: number;
  title: string;
  hint?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const heading = (
    <div className="space-y-1">
      <h3 id={id} className={ui.stepTitle}>
        {title}
        {optional && (
          <span className="ml-2 text-[13px] font-normal text-gray-500">
            {t("pricing.simple.optional")}
          </span>
        )}
      </h3>
      {hint && <p className={ui.stepHint}>{hint}</p>}
    </div>
  );
  if (number === undefined)
    return (
      <section aria-labelledby={id} className={ui.pricesSection}>
        {heading}
        {children}
      </section>
    );
  return (
    <section aria-labelledby={id} className={ui.stepCard}>
      <span aria-hidden="true" className={ui.stepNumber}>
        {number}
      </span>
      <div className="min-w-0 grow space-y-4">
        {heading}
        {children}
      </div>
    </section>
  );
}
