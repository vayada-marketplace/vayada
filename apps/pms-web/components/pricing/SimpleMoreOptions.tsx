"use client";

import type { ReactNode } from "react";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import type { Translate } from "./pricingAmounts";
import { hasKeptSettings, type SimpleRoom } from "./simplePricing";
import { childrenSummary, mainOffer, moreOptionsSummary } from "./stepPricing";
import * as ui from "./pricingStyles";

type Room = PricingConfiguration;

/** One group inside the open More options row. */
export function MoreGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2.5 border-gray-100 py-4 [&:not(:first-child)]:border-t">
      <div className="space-y-0.5">
        <h3 className="text-[15px] font-semibold text-gray-900">{title}</h3>
        {hint && <p className={ui.stepHint}>{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/** "Guests pay at the hotel or by card": the accepted methods in words. */
export function paymentText(methods: readonly string[], t: Translate) {
  const words = methods.map((method) => t(`pricing.simple.pay.${method}`));
  return words.length < 2
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} ${t("pricing.simple.pay.or")} ${words.at(-1)}`;
}

/** The closed More options row's line: the minimum stay, children, and anything else it holds, so no setting hides
 * behind it. How guests pay and the other booking options are in step "Rates" (VAY-2282). */
export function simpleSummary(room: Room, t: Translate) {
  const main = mainOffer(room);
  const nights = main.restrictions.kind === "own" ? main.restrictions.rules.minArrivalNights : 1;
  return [
    nights > 1
      ? t("pricing.simple.summary.minimum", { count: nights })
      : t("pricing.simple.summary.noMinimum"),
    ...(room.capacity.children > 0
      ? [t("pricing.simple.summary.children", { summary: childrenSummary(room, t) })]
      : []),
    ...(moreOptionsSummary(room, t)?.split(" · ") ?? []),
  ].join(" · ");
}
/** Whether the card's top leaves settings out (see `hasKeptSettings`), counting a deposit and a closed or stopped
 * main option too: the card then says they are kept. */
export function keptSettings(room: Room, simple: SimpleRoom | null) {
  if (!simple) return false;
  const rules = simple.main.restrictions.kind === "own" ? simple.main.restrictions.rules : null;
  return (
    hasKeptSettings(room, simple) ||
    simple.mainTerms.payment.kind === "deposit" ||
    !!(rules && (rules.closedToArrival || rules.closedToDeparture || rules.stopSell))
  );
}
