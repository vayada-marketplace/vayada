import type { PricingPaymentMethod } from "@vayada/domain-booking/replacement-pricing";
import type { PricingOffer } from "@/services/api/replacementOffers";

/** VAY-2320: a group books its rooms one at a time on the hotel page, each with its own room type
 * and rate. These helpers are the picker's rules; the server still checks every room. */

export type RoomGuests = { adults: number; children: number };

/** One room the group has chosen: its rate, its guests and the price shown when it was chosen. */
export type RoomPick = RoomGuests & {
  roomTypeId: string;
  publicOfferKey: string;
  /** The room's stay total for its adults, as the room card showed it; null when unpriced. */
  totalMinor: string | null;
  currency: string;
};

/** The most rooms one booking takes on the booking page. */
export const MAX_ROOMS = 9;

/** The group's guests spread over its rooms: adults evenly (the first rooms take any remainder),
 * children into the rooms with the fewest adults, last rooms first. */
export function splitParty(adults: number, children: number, rooms: number): RoomGuests[] {
  const count = Math.max(1, Math.min(rooms, adults));
  const split = Array.from({ length: count }, (_, index) => ({
    adults: Math.floor(adults / count) + (index < adults % count ? 1 : 0),
    children: 0,
  }));
  for (let child = 0; child < children; child++) split[count - 1 - (child % count)]!.children++;
  return split;
}

/** A rate the group can add next to the rates it already chose, or why not. One booking is paid
 * one way: the same schedule (in full, or the same deposit) and at least one shared way to pay.
 * Unknown schedules or methods (an older API) don't block: the quote decides. */
export function combinable(
  offer: PricingOffer,
  chosen: readonly PricingOffer[],
): "ok" | "paid_differently" {
  for (const other of chosen) {
    const a = offer.paymentSchedule,
      b = other.paymentSchedule;
    if (
      a &&
      b &&
      (a.kind !== b.kind || (a.kind === "deposit" && b.kind === "deposit" && a.key !== b.key))
    )
      return "paid_differently";
  }
  let shared: PricingPaymentMethod[] | null = offer.paymentMethods ?? null;
  for (const other of chosen) {
    if (!shared || !other.paymentMethods) continue;
    const methods = other.paymentMethods;
    shared = shared.filter((method) => methods.includes(method));
  }
  return shared && shared.length === 0 ? "paid_differently" : "ok";
}

const PICK = /^([1-9][0-9]?)-([0-9]{1,2})-(pricing-offer\.v2:[a-f0-9]{64})$/;

/** A pick as /book reads it from the URL: "<adults>-<children>-<public offer key>". */
export function encodePick(pick: RoomGuests & { publicOfferKey: string }): string {
  return `${pick.adults}-${pick.children}-${pick.publicOfferKey}`;
}

export function decodePicks(
  values: readonly string[],
): (RoomGuests & { publicOfferKey: string })[] | null {
  if (!values.length || values.length > MAX_ROOMS) return null;
  const picks = [];
  for (const value of values) {
    const match = PICK.exec(value);
    if (!match) return null;
    picks.push({
      adults: Number(match[1]),
      children: Number(match[2]),
      publicOfferKey: match[3]!,
    });
  }
  return picks;
}

/** The group's picks for one search, kept per tab so Back from /book finds them again. */
type PickDraft = { identity: string; picks: (RoomPick | null)[] };
const draftKey = (slug: string) => `roomPicks:${slug}`;

export function readPickDraft(slug: string, identity: string): (RoomPick | null)[] | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(draftKey(slug)) ?? "null") as PickDraft | null;
    if (!raw || raw.identity !== identity || !Array.isArray(raw.picks)) return null;
    const valid = raw.picks.every(
      (pick) =>
        pick === null ||
        (typeof pick === "object" &&
          typeof pick.roomTypeId === "string" &&
          typeof pick.publicOfferKey === "string" &&
          typeof pick.currency === "string" &&
          (pick.totalMinor === null || /^(0|[1-9][0-9]*)$/.test(String(pick.totalMinor))) &&
          Number.isSafeInteger(pick.adults) &&
          Number.isSafeInteger(pick.children)),
    );
    return valid ? raw.picks : null;
  } catch {
    return null;
  }
}

export function savePickDraft(slug: string, identity: string, picks: (RoomPick | null)[]) {
  try {
    sessionStorage.setItem(draftKey(slug), JSON.stringify({ identity, picks }));
  } catch {
    // Storage off (private mode): the picks live as long as the page.
  }
}
