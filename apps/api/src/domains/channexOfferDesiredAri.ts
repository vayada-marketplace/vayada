import { createHash } from "node:crypto";
import { parsePricingConfiguration } from "@vayada/domain-pms";
import {
  prepareParsedChannexAdultNightPrices,
  type ChannexAdultNightPrices,
} from "../integrations/channexNightlyPrices.js";
import { DEFAULT_FULL_ARI_DAYS_AHEAD } from "../jobs/pmsChannexAriHorizon.js";
import { channexPropertyLocalDate } from "./channexInitialAriDate.js";

type PreparedNight = Extract<ChannexAdultNightPrices, { kind: "prepared" }>;
type RateIdentity = Readonly<{ externalPropertyId: string; externalRatePlanId: string }>;

/** One Channex `values[]` entry for one offer night. Priced entries carry every adult occupancy
 * and the night's restrictions; an unpriced night only closes sales. */
export type ChannexOfferAriValue =
  | Readonly<{
      property_id: string;
      rate_plan_id: string;
      date: string;
      rates: readonly Readonly<{ occupancy: number; rate: string }>[];
      min_stay_arrival: number;
      min_stay_through: 1;
      max_stay: number;
      closed_to_arrival: boolean;
      closed_to_departure: boolean;
      stop_sell: boolean;
    }>
  | Readonly<{ property_id: string; rate_plan_id: string; date: string; stop_sell: true }>;

/** The single value builder for initial and ongoing offer ARI (VAY-2108 D2), so both send the
 * same math. `forceStopSell` closes sales regardless of the night's own rules. Channex requires
 * strictly positive rates; a partial occupancy set is never built. */
export function buildChannexOfferAriValue(
  prepared: PreparedNight,
  identity: RateIdentity,
  options: { forceStopSell: boolean },
):
  | Readonly<{ kind: "value"; value: ChannexOfferAriValue }>
  | Readonly<{ kind: "unavailable"; reason: "provider_rate_unavailable" }> {
  const [first] = prepared.candidates;
  if (!first || prepared.candidates.some((c) => BigInt(c.projection.night.totalMinor) <= 0n))
    return { kind: "unavailable", reason: "provider_rate_unavailable" };
  return {
    kind: "value",
    value: {
      property_id: identity.externalPropertyId,
      rate_plan_id: identity.externalRatePlanId,
      date: first.projection.night.date,
      rates: prepared.candidates.map(({ occupancy, rate }) => ({ occupancy, rate })),
      ...first.restrictionCandidate,
      stop_sell: first.restrictionCandidate.stop_sell || options.forceStopSell,
    },
  };
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, (item as Record<string, unknown>)[key]]),
        )
      : item,
  );

/** sha256 of the sorted-key JSON: the "desired" and "last sent" comparison of ongoing ARI. */
export function channexOfferAriValueSha256(value: ChannexOfferAriValue): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** The value without its date: consecutive dates with equal results may share one range entry. */
export function channexOfferAriValueWithoutDate(value: ChannexOfferAriValue) {
  const { date: _date, ...rest } = value;
  return rest;
}

const isoDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const addDays = (date: string, days: number) => {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
};

/** Desired ongoing ARI for one active offer target (VAY-2108 D2), pure over trusted inputs.
 * The window is clipped to hotel-local today .. today + DEFAULT_FULL_ARI_DAYS_AHEAD, so past
 * dates are never produced. A night without a price (or a non-positive one) is closed rather
 * than sold; any other projection failure makes the whole target unavailable. */
export function computeChannexOfferDesiredAri(input: {
  room: unknown;
  propertyId: string;
  roomTypeId: string;
  offerId: string;
  identity: RateIdentity;
  expectedRevision: number;
  expectedTermsRevisions: Readonly<Record<string, string>>;
  salesState: "open" | "closed";
  timeZone: unknown;
  now: Date;
  window?: Readonly<{ from?: string; through?: string }>;
}):
  | Readonly<{
      kind: "desired";
      from: string;
      through: string;
      values: readonly Readonly<{
        date: string;
        priced: boolean;
        value: ChannexOfferAriValue;
        valueSha256: string;
      }>[];
    }>
  | Readonly<{ kind: "unavailable"; reason: string }> {
  const today = channexPropertyLocalDate(input.timeZone, input.now);
  if (!today) return { kind: "unavailable", reason: "property_timezone_unavailable" };
  // Parse once: parsing dominates a night's cost and the window has 500 nights per occupancy.
  const config = parsePricingConfiguration(input.room);
  if (!config) return { kind: "unavailable", reason: "invalid_configuration" };
  // The calculator reports an unknown offer as a missing price; never close a whole horizon for it.
  if (!config.offers.some((offer) => offer.id === input.offerId))
    return { kind: "unavailable", reason: "selection_unavailable" };
  if (input.salesState !== "open" && input.salesState !== "closed")
    return { kind: "unavailable", reason: "sales_state_unavailable" };
  const { from: requestedFrom, through: requestedThrough } = input.window ?? {};
  if (
    (requestedFrom !== undefined && !isoDate(requestedFrom)) ||
    (requestedThrough !== undefined && !isoDate(requestedThrough))
  )
    return { kind: "unavailable", reason: "invalid_window" };
  const horizon = addDays(today, DEFAULT_FULL_ARI_DAYS_AHEAD);
  const from = requestedFrom && requestedFrom > today ? requestedFrom : today;
  const through = requestedThrough && requestedThrough < horizon ? requestedThrough : horizon;
  const values: Array<{
    date: string;
    priced: boolean;
    value: ChannexOfferAriValue;
    valueSha256: string;
  }> = [];
  for (let date = from; date <= through; date = addDays(date, 1)) {
    const prepared = prepareParsedChannexAdultNightPrices(config, {
      propertyId: input.propertyId,
      roomTypeId: input.roomTypeId,
      offerId: input.offerId,
      date,
      expectedRevision: input.expectedRevision,
      expectedTermsRevisions: input.expectedTermsRevisions,
    });
    const built =
      prepared.kind === "prepared"
        ? buildChannexOfferAriValue(prepared, input.identity, {
            forceStopSell: input.salesState !== "open",
          })
        : prepared;
    let value: ChannexOfferAriValue;
    if (built.kind === "value") value = built.value;
    else if (built.reason === "missing_price" || built.reason === "provider_rate_unavailable")
      value = {
        property_id: input.identity.externalPropertyId,
        rate_plan_id: input.identity.externalRatePlanId,
        date,
        stop_sell: true,
      };
    else return { kind: "unavailable", reason: built.reason };
    values.push({
      date,
      priced: built.kind === "value",
      value,
      valueSha256: channexOfferAriValueSha256(value),
    });
  }
  return { kind: "desired", from, through, values };
}
