import { bestBookingPromotion, type BookingRoomLine } from "@vayada/domain-booking";
import {
  type BookingWebQueryExecutor,
  type TargetCheckoutQuoteOfferRow,
} from "./bookingWebPublic.js";

type RoomLineTotals = Record<
  "roomTotal" | "taxesAndFees" | "discounts" | "promotionDiscount" | "totalAmount",
  string
>;
export type TargetQuotedRoomLine = BookingRoomLine & {
  offer: TargetCheckoutQuoteOfferRow;
  promotion: ReturnType<typeof bestBookingPromotion>;
  totals: RoomLineTotals;
};

/** Inactive until checkout persistence and all lifecycle consumers support selections. */
export async function quoteTargetRoomSelection(
  pool: BookingWebQueryExecutor,
  input: {
    propertyId: string;
    selection: unknown;
    checkIn: string;
    checkOut: string;
    currency: string;
    today: string;
    requestedAt: Date;
    promotionSettings?: unknown;
    credits?: ReadonlyMap<string, { checkIn: string; checkOut: string; roomCount: number }>;
    releasedSetupOffers?: ReadonlySet<string>;
  },
): Promise<{
  selection: import("@vayada/domain-booking").BookingRoomSelection;
  party: { adults: number; children: number; rooms: number };
  lines: TargetQuotedRoomLine[];
  totals: Record<string, string>;
  paymentOptions: string[];
  currency: string;
}> {
  throw Object.assign(
    new Error("Pricing is unavailable while the TypeScript pricing system is rebuilt."),
    { statusCode: 503, code: "PRICING_UNAVAILABLE" },
  );
}
