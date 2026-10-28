import type { PricingPaymentMethod } from "@vayada/domain-booking/replacement-pricing";
import type { PricingOffer, PricingRoom, RoomChoice } from "@/services/api/replacementOffers";

/** VAY-2320: a group books its rooms one at a time on the hotel page, each with its own room type
 * and rate. These helpers are the picker's rules; the server still checks every room. */

export type RoomGuests = { adults: number; children: number };

/** One room the group has chosen: its room type and rate. Its guests are the group's split
 * (VAY-2393), so a new split keeps the choice and only checks it still fits. */
export type RoomPick = { roomTypeId: string; publicOfferKey: string };

/** The most rooms one booking takes on the booking page. */
export const MAX_ROOMS = 9;

/** VAY-2393: the guests picker offers up to 4 rooms, more only when the group needs them. Every
 * room needs an adult. */
export function mostRooms(adults: number, fewest: number): number {
  return Math.max(1, Math.min(adults, MAX_ROOMS, Math.max(4, fewest)));
}

/** Adults spread evenly; the first rooms take any remainder (4 → 2+2, 5 → 3+2). */
export function evenSplit(adults: number, rooms: number): number[] {
  const count = Math.max(1, Math.min(rooms, adults));
  return Array.from(
    { length: count },
    (_, index) => Math.floor(adults / count) + (index < adults % count ? 1 : 0),
  );
}

/** Each room's guests: its adults, and the children in the rooms with the fewest adults, last
 * rooms first. */
export function roomGuests(adultsPerRoom: readonly number[], children: number): RoomGuests[] {
  const rooms = adultsPerRoom.map((adults) => ({ adults, children: 0 }));
  const order = rooms
    .map((_, index) => index)
    .sort((a, b) => rooms[a]!.adults - rooms[b]!.adults || b - a);
  for (let child = 0; child < children && order.length; child++)
    rooms[order[child % order.length]!]!.children++;
  return rooms;
}

/** The group's guests spread evenly over its rooms (see evenSplit and roomGuests). */
export function splitParty(adults: number, children: number, rooms: number): RoomGuests[] {
  return roomGuests(evenSplit(adults, rooms), children);
}

/** "Who sleeps where" (VAY-2393): one adult more or fewer in a room, the total unchanged. One
 * more comes from the room with the most adults, one fewer goes to the room with the fewest;
 * every room keeps an adult. The split as it was when the move isn't possible. */
export function moveAdult(split: readonly number[], index: number, delta: 1 | -1): number[] {
  const next = [...split];
  const others = next.map((_, position) => position).filter((position) => position !== index);
  const other =
    delta === 1
      ? others.filter((p) => next[p]! > 1).sort((a, b) => next[b]! - next[a]! || b - a)[0]
      : next[index]! > 1
        ? others.sort((a, b) => next[a]! - next[b]! || a - b)[0]
        : undefined;
  if (other === undefined) return next;
  next[index]! += delta;
  next[other]! -= delta;
  return next;
}

/** One room for these guests: an adult and within every limit, as the API sizes it. Unknown
 * limits fit: the quote decides. */
export function fitsRoom(occupancy: PricingRoom["occupancy"], guests: RoomGuests): boolean {
  if (guests.adults < 1) return false;
  if (!occupancy) return true;
  return (
    guests.adults <= occupancy.maxAdults &&
    guests.children <= occupancy.maxChildren &&
    guests.adults + guests.children <= occupancy.maxGuests
  );
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

/** The group's split and picks for one stay, kept per tab so Back from /book and a refresh find
 * them again. Other guests or rooms keep the picks (VAY-2393); a split for other guests is
 * ignored. */
export type PickDraft = { split: number[]; picks: (RoomPick | null)[] };
const draftKey = (slug: string) => `roomPicks:${slug}`;
const count = (value: unknown, min: number) =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= 99;

export function readPickDraft(slug: string, identity: string): PickDraft | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(draftKey(slug)) ?? "null") as
      | (PickDraft & { identity: unknown })
      | null;
    if (
      !raw ||
      raw.identity !== identity ||
      !Array.isArray(raw.split) ||
      !Array.isArray(raw.picks) ||
      raw.split.length > MAX_ROOMS ||
      raw.picks.length > MAX_ROOMS ||
      !raw.split.every((adults) => count(adults, 1))
    )
      return null;
    const valid = raw.picks.every(
      (pick) =>
        pick === null ||
        (typeof pick === "object" &&
          typeof pick.roomTypeId === "string" &&
          typeof pick.publicOfferKey === "string"),
    );
    return valid ? { split: raw.split, picks: raw.picks } : null;
  } catch {
    return null;
  }
}

export function savePickDraft(slug: string, identity: string, draft: PickDraft) {
  try {
    sessionStorage.setItem(draftKey(slug), JSON.stringify({ identity, ...draft }));
  } catch {
    // Storage off (private mode): the picks live as long as the page.
  }
}

/** One stay's identity for its picks: other dates or promo start afresh, since prices and free
 * rooms change with them. */
export function pickIdentity(search: {
  checkIn: string;
  checkOut: string;
  promoCode: string | null;
}): string {
  return JSON.stringify([search.checkIn, search.checkOut, search.promoCode]);
}

/** VAY-2320: rooms that sold out at the last step are chosen again on the hotel page; the
 * group's other rooms stay chosen. */
export function releaseSoldOutPicks(
  slug: string,
  identity: string,
  roomTypeIds: readonly string[],
): void {
  const draft = readPickDraft(slug, identity);
  if (!draft) return;
  savePickDraft(slug, identity, {
    split: draft.split,
    picks: draft.picks.map((pick) => (pick && roomTypeIds.includes(pick.roomTypeId) ? null : pick)),
  });
}

/** What a room's guests break, against its limits (VAY-2320). */
export function roomGuestProblem(
  room: PricingRoom | undefined,
  choice: RoomChoice,
): "no_adult" | "too_many" | "too_many_adults" | "no_children" | "too_many_children" | null {
  const adults = Number(choice.adults) || 0;
  const children = choice.childAges.length;
  if (adults < 1) return "no_adult";
  const limits = room?.occupancy;
  if (!limits) return null;
  if (children > 0 && limits.maxChildren === 0) return "no_children";
  if (adults + children > limits.maxGuests) return "too_many";
  if (adults > limits.maxAdults) return "too_many_adults";
  if (children > limits.maxChildren) return "too_many_children";
  return null;
}
