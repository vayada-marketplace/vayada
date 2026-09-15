import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { pricingCurrencyScale } from "@vayada/domain-pms";
import type { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { pricingDecimalMinor } from "./pricingDecimalMinor.js";
import { projectPricingBookingAddons } from "./pricingBookingAddons.js";

type Current = NonNullable<Awaited<ReturnType<typeof lockCurrentQuoteRevalidation>>>;
/** Internal staging only. Retain this transaction's pre-mutation owner locks.
 * The caller creates the draft booking, stages all other effects, runs the final
 * gate and rolls back everything on rejection. No legacy quote link or payment. */
export async function persistPricingBookingAddons(
  client: PoolClient,
  slug: unknown,
  current: Current,
  bookingId: string,
) {
  const fail = (): never => {
    throw new Error("Booking extras are unavailable");
  };
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId) ||
    current.kind !== "current_quote_price" ||
    current.scope.propertyId !== current.quote.stay.propertyId
  )
    return fail();
  const scope = await lockPublicPricingAuthority(client, slug);
  if (!scope || !isDeepStrictEqual(scope, current.scope)) return fail();
  const rows = projectPricingBookingAddons(current);
  const scale = pricingCurrencyScale(current.quote.stay.currency);
  if (!rows || scale === null) return fail();
  const booking = (
    await client.query(
      `SELECT id,check_in::text,check_out::text,currency,room_count,
      total_amount::text,booking_metadata,lifecycle_status,edit_revision
    FROM booking.guest_bookings WHERE id=$1 AND property_id=$2 FOR UPDATE`,
      [bookingId, scope.propertyId],
    )
  ).rows[0];
  if (
    !booking ||
    booking.lifecycle_status !== "draft" ||
    booking.edit_revision !== 0 ||
    booking.booking_metadata?.pricingQuoteId !== current.quote.quoteId ||
    booking.check_in !== current.quote.stay.checkIn ||
    booking.check_out !== current.quote.stay.checkOut ||
    booking.currency !== current.quote.stay.currency ||
    booking.room_count !== current.quote.stay.rooms.length ||
    pricingDecimalMinor(booking.total_amount, scale) !== current.quote.evidence.totalMinor
  )
    return fail();
  const prior = (
    await client.query(
      `SELECT addon_definition_id AS "addonDefinitionId",addon_snapshot AS "addonSnapshot",
      edit_revision,quantity,service_date::text AS "serviceDate",total_amount::text AS "totalAmount",currency,
      ownership_kind_snapshot AS "ownershipKind",partner_commission_rate_snapshot::text AS "partnerCommissionRate"
    FROM booking.booking_addon_selections WHERE guest_booking_id=$1 AND property_id=$2 ORDER BY addon_definition_id,service_date FOR UPDATE`,
      [bookingId, scope.propertyId],
    )
  ).rows;
  const canonical = (values: typeof rows) =>
    values
      .map((row) => ({
        ...row,
        totalAmount: pricingDecimalMinor(row.totalAmount, scale),
        partnerCommissionRate:
          row.partnerCommissionRate === null
            ? null
            : pricingDecimalMinor(row.partnerCommissionRate, 4),
      }))
      .sort((a, b) =>
        `${a.addonDefinitionId}/${a.serviceDate}`.localeCompare(
          `${b.addonDefinitionId}/${b.serviceDate}`,
        ),
      );
  if (prior.length) {
    if (prior.some((row) => row.edit_revision !== 0)) return fail();
    const saved = prior.map((row) => {
      const copy = { ...row };
      delete copy.edit_revision;
      return copy;
    });
    if (!isDeepStrictEqual(canonical(saved as typeof rows), canonical(rows))) return fail();
    return { count: prior.length, replayed: true };
  }
  if (!rows.length) return { count: 0, replayed: false };
  const inserted = await client.query(
    `INSERT INTO booking.booking_addon_selections
      (property_id,guest_booking_id,addon_definition_id,addon_snapshot,quantity,service_date,total_amount,currency,
       ownership_kind_snapshot,partner_commission_rate_snapshot,edit_revision)
    SELECT $1,$2,r."addonDefinitionId",r."addonSnapshot",r.quantity,r."serviceDate",r."totalAmount",r.currency,
      r."ownershipKind",r."partnerCommissionRate",0
    FROM jsonb_to_recordset($3::jsonb) AS r("addonDefinitionId" uuid,"addonSnapshot" jsonb,quantity integer,
      "serviceDate" date,"totalAmount" numeric,currency text,"ownershipKind" text,"partnerCommissionRate" numeric)
    RETURNING id`,
    [scope.propertyId, bookingId, JSON.stringify(rows)],
  );
  if (inserted.rowCount !== rows.length) return fail();
  return { count: rows.length, replayed: false };
}
