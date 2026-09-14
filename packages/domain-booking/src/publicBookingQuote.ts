import {
  isMinorAmount,
  parseFlexibleCancellationTerms,
  pricingKeys,
  pricingObject,
} from "@vayada/domain-pms/replacement-pricing";
import type { PublicPricingSelection } from "./publicPricingSelection.js";
import type { ReplacementOfferTerms } from "./replacementPricingEvidence.js";
import { validOptionalPricingPaymentMethods } from "./pricingPaymentMethods.js";

export type PublicBookingQuoteRequest = Readonly<{
  version: "public-booking-quote-request.v1";
  selection: PublicPricingSelection;
  paymentMethod: "card" | "pay_at_property";
}>;
export type PublicBookingQuote = Readonly<{
  version: "public-booking-quote.v1";
  quoteId: string;
  replayed: boolean;
  checkIn: string;
  checkOut: string;
  currency: string;
  paymentMethod: string;
  issuedAt: string;
  expiresAt: string;
  totalMinor: string;
  dueNowMinor: string;
  dueLaterMinor: string;
  lines: readonly {
    kind: "room" | "meal" | "addon" | "charge" | "discount";
    selectionId: string | null;
    amountMinor: string;
  }[];
  rooms: readonly {
    selectionId: string;
    mealPlan: string;
    cancellation: ReplacementOfferTerms["cancellation"];
    payment: ReplacementOfferTerms["payment"];
  }[];
}>;
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  pricingObject(v) && pricingKeys(v, keys);
const iso = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
/** Browser response validation, not authority to accept a booking. Expiry is checked by the caller. */
export function parsePublicBookingQuote(
  value: unknown,
  request: PublicBookingQuoteRequest,
): PublicBookingQuote | null {
  if (
    !exact(value, [
      "version",
      "quoteId",
      "replayed",
      "checkIn",
      "checkOut",
      "currency",
      "paymentMethod",
      "issuedAt",
      "expiresAt",
      "totalMinor",
      "dueNowMinor",
      "dueLaterMinor",
      "lines",
      "rooms",
    ]) ||
    value.version !== "public-booking-quote.v1" ||
    typeof value.quoteId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.quoteId) ||
    typeof value.replayed !== "boolean" ||
    value.checkIn !== request.selection.checkIn ||
    value.checkOut !== request.selection.checkOut ||
    value.currency !== request.selection.currency ||
    value.paymentMethod !== request.paymentMethod ||
    !iso(value.issuedAt) ||
    !iso(value.expiresAt) ||
    value.expiresAt <= value.issuedAt ||
    ![value.totalMinor, value.dueNowMinor, value.dueLaterMinor].every(isMinorAmount) ||
    !Array.isArray(value.rooms) ||
    value.rooms.length !== request.selection.rooms.length ||
    !Array.isArray(value.lines) ||
    !value.lines.length ||
    value.lines.length > 10000
  )
    return null;
  const ids = new Set(request.selection.rooms.map((room) => room.selectionId));
  const seen = new Set<string>();
  for (const room of value.rooms) {
    if (
      !exact(room, ["selectionId", "mealPlan", "cancellation", "payment"]) ||
      typeof room.selectionId !== "string" ||
      !ids.has(room.selectionId) ||
      seen.has(room.selectionId) ||
      !["room_only", "breakfast", "half_board", "full_board", "all_inclusive"].includes(
        room.mealPlan as string,
      )
    )
      return null;
    seen.add(room.selectionId);
    const c = room.cancellation,
      p = room.payment;
    if (
      !(exact(c, ["kind"]) && c.kind === "non_refundable") &&
      !(
        exact(c, ["kind", "terms"]) &&
        c.kind === "flexible" &&
        parseFlexibleCancellationTerms(c.terms)
      )
    )
      return null;
    // Public issuance currently supports full payment terms only; do not infer deposit execution.
    if (
      !exact(p, ["kind", "acceptedMethods"]) ||
      p.kind !== "full" ||
      !validOptionalPricingPaymentMethods(p) ||
      !(p.acceptedMethods as string[]).includes(request.paymentMethod)
    )
      return null;
  }
  let sum = BigInt(0);
  const roomLines = new Set<string>();
  for (const line of value.lines) {
    if (
      !exact(line, ["kind", "selectionId", "amountMinor"]) ||
      !isMinorAmount(line.amountMinor) ||
      !["room", "meal", "addon", "charge", "discount"].includes(line.kind as string) ||
      !(
        line.selectionId === null ||
        (typeof line.selectionId === "string" && ids.has(line.selectionId))
      ) ||
      (["room", "meal"].includes(line.kind as string) && line.selectionId === null)
    )
      return null;
    if (line.kind === "room" && BigInt(line.amountMinor) > BigInt(0))
      roomLines.add(line.selectionId as string);
    sum += BigInt(line.amountMinor) * (line.kind === "discount" ? BigInt(-1) : BigInt(1));
  }
  if (
    sum <= BigInt(0) ||
    sum !== BigInt(value.totalMinor as string) ||
    roomLines.size !== ids.size ||
    BigInt(value.dueNowMinor as string) + BigInt(value.dueLaterMinor as string) !== sum
  )
    return null;
  return structuredClone(value) as PublicBookingQuote;
}
