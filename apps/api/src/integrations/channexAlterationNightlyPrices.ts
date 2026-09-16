import { z } from "zod";

const date = z.iso.date().refine((value) => !value.startsWith("0000-"));
const amount = z.string().regex(/^\d{1,15}(?:\.\d{1,4})?$/);
const room = z.object({
  room_type_id: z.uuid(),
  checkin_date: date.optional(),
  checkout_date: date.optional(),
  days: z.record(date, amount.nullable()).nullish(),
});
const revision = z.object({
  id: z.string().min(1).max(500),
  booking_id: z.uuid(),
  property_id: z.uuid(),
  status: z.literal("modified"),
  arrival_date: date,
  departure_date: date,
  currency: z.string().regex(/^[A-Z]{3}$/),
  rooms: z.array(room).min(1).max(100),
});
const scope = z.object({
  revisionId: z.string().min(1).max(500),
  providerBookingId: z.uuid(),
  providerPropertyId: z.uuid(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  checkIn: date,
  checkOut: date,
  rooms: z
    .array(z.object({ providerRoomTypeId: z.uuid(), roomTypeId: z.uuid() }))
    .min(1)
    .max(100),
});

export type ChannexAlterationNightlyPriceScope = z.infer<typeof scope>;
export type ChannexAlterationNightlyPrice = {
  roomTypeId: string;
  linePosition: number;
  stayDate: string;
  providerNightlyAmount: string | null;
};

/** Caller supplies rooms in validated provider position order from its scoped mapping. */
export function readChannexAlterationNightlyPrices(
  raw: unknown,
  expected: ChannexAlterationNightlyPriceScope,
): ChannexAlterationNightlyPrice[] {
  try {
    const checkedScope = scope.parse(expected);
    const outer = z.record(z.string(), z.unknown()).parse(raw);
    const envelope = z.record(z.string(), z.unknown()).parse(outer["data"] ?? outer);
    const attributes = z.record(z.string(), z.unknown()).parse(envelope["attributes"] ?? envelope);
    const value = revision.parse({ ...attributes, id: envelope["id"] ?? attributes["id"] });
    if (
      value.id !== checkedScope.revisionId ||
      value.booking_id !== checkedScope.providerBookingId ||
      value.property_id !== checkedScope.providerPropertyId ||
      value.currency !== checkedScope.currency ||
      value.arrival_date !== checkedScope.checkIn ||
      value.departure_date !== checkedScope.checkOut ||
      value.rooms.length !== checkedScope.rooms.length
    )
      throw new Error();
    const start = Date.parse(value.arrival_date);
    const nights = (Date.parse(value.departure_date) - start) / 86_400_000;
    if (nights < 1 || nights * value.rooms.length > 1_000) throw new Error();
    const result: ChannexAlterationNightlyPrice[] = [];
    for (const [index, item] of value.rooms.entries()) {
      const mapped = checkedScope.rooms[index]!;
      if (
        item.room_type_id !== mapped.providerRoomTypeId ||
        (item.checkin_date !== undefined && item.checkin_date !== value.arrival_date) ||
        (item.checkout_date !== undefined && item.checkout_date !== value.departure_date) ||
        Object.keys(item.days ?? {}).some(
          (day) => day < value.arrival_date || day >= value.departure_date,
        )
      )
        throw new Error();
      for (let night = 0; night < nights; night++) {
        const stayDate = new Date(start + night * 86_400_000).toISOString().slice(0, 10);
        result.push({
          roomTypeId: mapped.roomTypeId,
          linePosition: index + 1,
          stayDate,
          providerNightlyAmount: item.days?.[stayDate] ?? null,
        });
      }
    }
    return result;
  } catch {
    // Do not propagate provider payloads or guest data through validation errors.
    throw new Error("alteration_revision_nightly_prices_invalid");
  }
}
