import { z } from "zod";
import {
  readChannexAlterationNightlyPrices,
  type ChannexAlterationNightlyPriceScope,
} from "./channexAlterationNightlyPrices.js";

const amount = z.string().regex(/^\d{1,15}(?:\.\d{1,4})?$/);
const settingsSchema = z.object({
  booking_amount_settings: z.enum(["Payout Amount", "Total Paid Amount"]),
  cohost_payout_calculations: z.boolean().nullable(),
});
const financialsSchema = z.object({
  ota_name: z.literal("Airbnb"),
  amount,
  ota_commission: amount.nullish(),
  rooms: z
    .array(
      z.object({
        amount,
        taxes: z
          .array(
            z.object({
              total_price: amount,
              is_inclusive: z.boolean(),
              type: z.string().min(1).max(100),
            }),
          )
          .max(100)
          .nullish(),
      }),
    )
    .min(1)
    .max(100),
});

/** Caller resolves the channel settings applicable to this revision; no DB or provider writes. */
export function readChannexAirbnbAlterationFinancialSnapshot(
  raw: unknown,
  expected: ChannexAlterationNightlyPriceScope,
  channelSettings: z.infer<typeof settingsSchema>,
) {
  try {
    const settings = settingsSchema.parse(channelSettings);
    const outer = z.record(z.string(), z.unknown()).parse(raw);
    const envelope = z.record(z.string(), z.unknown()).parse(outer["data"] ?? outer);
    const attributes = z.record(z.string(), z.unknown()).parse(envelope["attributes"] ?? envelope);
    if (attributes["status"] === "cancelled" || attributes["status"] === "canceled") {
      const cancellation = z
        .object({
          id: z.literal(expected.revisionId),
          booking_id: z.literal(expected.providerBookingId),
          property_id: z.literal(expected.providerPropertyId),
          currency: z.literal(expected.currency),
          ota_name: z.literal("Airbnb"),
          amount: amount.nullish(),
          ota_commission: amount.nullish(),
        })
        .parse({ ...attributes, id: envelope["id"] ?? attributes["id"] });
      // A cancellation total is provider evidence, not a refund or retained room revenue.
      // Do not retain or invent occupied nights, even if the provider repeats the old stay.
      return {
        revisionId: cancellation.id,
        providerPropertyId: cancellation.property_id,
        providerBookingId: cancellation.booking_id,
        currency: cancellation.currency,
        checkIn: expected.checkIn,
        checkOut: expected.checkOut,
        replacement: "cancellation" as const,
        amountBasis: settings.booking_amount_settings,
        cohostPayoutCalculations: settings.cohost_payout_calculations,
        nightlyAllocation: "unavailable" as const,
        providerBookingAmount: cancellation.amount ?? null,
        otaCommission: cancellation.ota_commission ?? null,
        rooms: [],
        nights: [],
      };
    }
    const prices = readChannexAlterationNightlyPrices(raw, expected);
    const value = financialsSchema.parse(attributes);
    const nights = prices.map((line) => {
      if (line.providerNightlyAmount === null) throw new Error();
      return { ...line, providerNightlyAmount: line.providerNightlyAmount };
    });
    return {
      revisionId: expected.revisionId,
      providerPropertyId: expected.providerPropertyId,
      providerBookingId: expected.providerBookingId,
      currency: expected.currency,
      checkIn: expected.checkIn,
      checkOut: expected.checkOut,
      replacement: "full_stay" as const,
      amountBasis: settings.booking_amount_settings,
      cohostPayoutCalculations: settings.cohost_payout_calculations,
      nightlyAllocation: "provider_allocated" as const,
      providerBookingAmount: value.amount,
      otaCommission: value.ota_commission ?? null,
      rooms: value.rooms.map((room, index) => ({
        linePosition: index + 1,
        roomTypeId: expected.rooms[index]!.roomTypeId,
        providerRoomAmount: room.amount,
        taxes:
          room.taxes?.map((tax) => ({
            amount: tax.total_price,
            includedInRoomAmount: tax.is_inclusive,
            type: tax.type,
          })) ?? null,
      })),
      nights,
    };
  } catch {
    throw new Error("airbnb_alteration_financial_snapshot_invalid");
  }
}
