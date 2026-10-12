"use client";

import { useId, type ReactNode } from "react";
import * as ui from "./pricingStyles";

/** One numbered question of the step-by-step Prices tab. */
export function StepCard({
  number,
  title,
  hint,
  children,
}: {
  number: number;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={ui.stepCard}>
      <span aria-hidden="true" className={ui.stepNumber}>
        {number}
      </span>
      <div className="min-w-0 grow space-y-4">
        <div className="space-y-1">
          <h3 id={id} className={ui.stepTitle}>
            {title}
          </h3>
          {hint && <p className={ui.stepHint}>{hint}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}
