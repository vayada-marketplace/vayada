import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { baseAmounts, decimalAmount } from "./pricingAmounts";

type Offer = PricingConfiguration["offers"][number];
type Base = Extract<Offer["price"], { kind: "independent" }>["calendar"]["base"];
type Adjustment = Extract<Offer["price"], { kind: "linked" }>["adjustment"];
type Restrictions = Extract<Offer["restrictions"], { kind: "own" }>["rules"];
export function PricingRules({ room, offer, scale }: { room: PricingConfiguration; offer: Offer; scale: number }) {
  const { t } = useTranslation();
  const money = (minor: string) => `${minor.startsWith("-") ? "−" : ""}${decimalAmount(minor.replace(/^-/, ""), scale)} ${room.currency}`;
  const adjustment = (value: Adjustment) => value.kind === "fixed" ? money(value.deltaMinor) : `${value.basisPoints / 100}%`;
  const price = (base: Base) => base ? baseAmounts(base, t).map(([label, minor]) => `${label}: ${money(minor)}`).join("; ") +
    (base.mode === "included_guests" ? `; ${t("pricing.rules.adjustmentsFromBase", { adjustments: base.adjustments.map((value, index) => `${t(index ? "pricing.adults.other" : "pricing.adults.one", { count: index + 1 })} ${adjustment(value)}`).join("; ") })}` : "") : t("pricing.rules.noBasePrice");
  const rules = (value: Restrictions) => t("pricing.rules.stayRules", { min: value.minArrivalNights, max: value.maxStayNights ?? t("pricing.stay.unlimited"), arrivals: t(value.closedToArrival ? "pricing.stay.closed" : "pricing.stay.open"), departures: t(value.closedToDeparture ? "pricing.stay.closed" : "pricing.stay.open"), sales: t(value.stopSell ? "pricing.stay.stopped" : "pricing.stay.open") });
  const calendar = offer.price.kind === "independent" ? offer.price.calendar : null;
  const parentId = offer.price.kind === "linked" ? offer.price.parentId : null;
  const dates = offer.price.kind === "linked" ? offer.price.dateOverrides : offer.price.calendar.dates;
  return <div className="mt-2 space-y-1">
    {offer.price.kind === "linked" && <p>{t("pricing.rules.parent", { number: room.offers.findIndex((parent) => parent.id === parentId) + 1, adjustment: adjustment(offer.price.adjustment) })}</p>}
    {calendar?.base?.mode === "included_guests" && <p>{t("pricing.rules.occupancyAdjustments", { adjustments: calendar.base.adjustments.map((value, index) => `${t(index ? "pricing.adults.other" : "pricing.adults.one", { count: index + 1 })} ${adjustment(value)}`).join("; ") })}</p>}
    {calendar?.months.map((entry) => <p key={entry.month}>{t("pricing.rules.month", { month: entry.month, price: price(entry.price) })}</p>)}
    {calendar?.seasons.map((entry, index) => <p key={index}>{entry.name} ({entry.tier}), {entry.from}–{entry.through}: {price(entry.price)}</p>)}
    {calendar?.weekdays.map((entry) => <p key={entry.day}>{t(`pricing.weekday.${entry.day}`)}: {adjustment(entry.adjustment)}</p>)}
    {dates.map((entry) => <p key={entry.date}>{entry.date}: {price(entry.price)}</p>)}
    {offer.restrictions.kind === "inherit" ? <p>{t("pricing.rules.inherited")}</p> : <>
      <p>{rules(offer.restrictions.rules)}</p>
      {offer.restrictions.seasons.map((entry, index) => <p key={index}>{entry.from}–{entry.through}: {rules(entry.rules)}</p>)}
      {offer.restrictions.dates.map((entry) => <p key={entry.date}>{entry.date}: {rules(entry.rules)}</p>)}
    </>}
  </div>;
}
