import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { baseAmounts, decimalAmount } from "./pricingAmounts";

type Offer = PricingConfiguration["offers"][number];
type Base = Extract<Offer["price"], { kind: "independent" }>["calendar"]["base"];
type Adjustment = Extract<Offer["price"], { kind: "linked" }>["adjustment"];
type Restrictions = Extract<Offer["restrictions"], { kind: "own" }>["rules"];
export function PricingRules({ room, offer, scale }: { room: PricingConfiguration; offer: Offer; scale: number }) {
  const money = (minor: string) => `${minor.startsWith("-") ? "−" : ""}${decimalAmount(minor.replace(/^-/, ""), scale)} ${room.currency}`;
  const adjustment = (value: Adjustment) => value.kind === "fixed" ? money(value.deltaMinor) : `${value.basisPoints / 100}%`;
  const price = (base: Base) => base ? baseAmounts(base).map(([label, minor]) => `${label}: ${money(minor)}`).join("; ") +
    (base.mode === "included_guests" ? `; adjustments from base: ${base.adjustments.map((value, index) => `${index + 1} guests ${adjustment(value)}`).join("; ")}` : "") : "No base price";
  const rules = (value: Restrictions) => `Minimum arrival stay ${value.minArrivalNights} nights; maximum stay ${value.maxStayNights ?? "unlimited"}; arrivals ${value.closedToArrival ? "closed" : "open"}; departures ${value.closedToDeparture ? "closed" : "open"}; sales ${value.stopSell ? "stopped" : "open"}`;
  const calendar = offer.price.kind === "independent" ? offer.price.calendar : null;
  const parentId = offer.price.kind === "linked" ? offer.price.parentId : null;
  const dates = offer.price.kind === "linked" ? offer.price.dateOverrides : offer.price.calendar.dates;
  return <div className="mt-2 space-y-1">
    {offer.price.kind === "linked" && <p>Parent: Offer {room.offers.findIndex((parent) => parent.id === parentId) + 1}; adjustment {adjustment(offer.price.adjustment)}.</p>}
    {calendar?.base?.mode === "included_guests" && <p>Occupancy adjustments from base: {calendar.base.adjustments.map((value, index) => `${index + 1} guests ${adjustment(value)}`).join("; ")}</p>}
    {calendar?.months.map((entry) => <p key={entry.month}>Month {entry.month}: {price(entry.price)}</p>)}
    {calendar?.seasons.map((entry, index) => <p key={index}>{entry.name} ({entry.tier}), {entry.from}–{entry.through}: {price(entry.price)}</p>)}
    {calendar?.weekdays.map((entry) => <p key={entry.day}>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][entry.day]}: {adjustment(entry.adjustment)}</p>)}
    {dates.map((entry) => <p key={entry.date}>{entry.date}: {price(entry.price)}</p>)}
    {offer.restrictions.kind === "inherit" ? <p>Stay restrictions inherited from parent.</p> : <>
      <p>{rules(offer.restrictions.rules)}</p>
      {offer.restrictions.seasons.map((entry, index) => <p key={index}>{entry.from}–{entry.through}: {rules(entry.rules)}</p>)}
      {offer.restrictions.dates.map((entry) => <p key={entry.date}>{entry.date}: {rules(entry.rules)}</p>)}
    </>}
    <p>Cancellation and payment terms are unchanged. Their details cannot be viewed in this editor yet.</p>
  </div>;
}
