"use client";

import { useId, type ReactNode } from "react";
import { useTranslation } from "@/lib/i18n";
import * as ui from "./pricingStyles";

/** One numbered question card (the first-price form), or, without `number`, one section of the simple Prices card
 * (VAY-2188): a title, "Optional" when it is, and a short hint. `step` makes it a step of "Pricing setup" (VAY-2305,
 * the CEO's design): the number, title and hint on the left, the step's card on the right, and `side` beside the card
 * (step 4's booking-page preview). Phones stack them. */
export function StepCard({
  number,
  step,
  title,
  hint,
  optional = false,
  side,
  children,
}: {
  number?: number;
  step?: number;
  title: string;
  hint?: string;
  optional?: boolean;
  side?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const optionalText = optional && (
    <span className="ml-2 text-[13px] font-normal text-gray-500">
      {t("pricing.simple.optional")}
    </span>
  );
  if (step !== undefined)
    return (
      <section aria-labelledby={id} className={ui.setupStep}>
        <div className={ui.setupStepIntro}>
          <span aria-hidden="true" className={ui.sectionNumber}>
            {step}
          </span>
          <h3 id={id} className={ui.setupStepTitle}>
            {title}
            {optionalText}
          </h3>
          {hint && <p className={ui.stepHint}>{hint}</p>}
        </div>
        <div className="min-w-0 flex-1 space-y-4 xl:flex xl:items-start xl:gap-4 xl:space-y-0">
          <div className={ui.setupStepCard}>{children}</div>
          {side && <div className="min-w-0 xl:w-[320px] xl:shrink-0">{side}</div>}
        </div>
      </section>
    );
  const heading = (
    <div className="space-y-1">
      <h3 id={id} className={ui.stepTitle}>
        {title}
        {optionalText}
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
