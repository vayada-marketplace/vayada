import type { PoolClient } from "pg";
import { isPositiveMinor, pricingCurrencyScale } from "@vayada/domain-pms";
import { decodeCurrentPricingQuoteRecord } from "./currentPricingQuoteStore.js";
import { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { pricingDecimalMinor } from "./pricingDecimalMinor.js";

/** Internal acceptance step. Caller owns READ COMMITTED and must roll back the
 * booking, inventory and redemption together on any later failure. No payment execution. */
export async function redeemCurrentQuotePromo(
  client: PoolClient,
  slug: unknown,
  quoteId: unknown,
  guestBookingId: unknown,
) {
  const fail = (): never => {
    throw new Error("Quote promotion is unavailable");
  };
  const uuid = (v: unknown) =>
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
  if (!uuid(quoteId) || !uuid(guestBookingId)) return fail();
  const scope = await lockPublicPricingAuthority(client, slug);
  if (!scope) return fail();
  const row = (
    await client.query(
      "SELECT id,payload FROM booking.pricing_quotes WHERE id=$1 AND property_id=$2 AND organization_id=$3",
      [quoteId, scope.propertyId, scope.organizationId],
    )
  ).rows[0];
  const stored = row
    ? decodeCurrentPricingQuoteRecord(row.payload, scope.propertyId, row.id)
    : null;
  if (!stored) return fail();
  const { quote } = stored,
    scale = pricingCurrencyScale(quote.stay.currency);
  const booking = (
    await client.query(
      `SELECT id,check_in::text,check_out::text,currency,room_count,total_amount::text,booking_metadata,lifecycle_status
    FROM booking.guest_bookings WHERE id=$1 AND property_id=$2 FOR UPDATE`,
      [guestBookingId, scope.propertyId],
    )
  ).rows[0];
  if (
    !booking ||
    scale === null ||
    booking.booking_metadata.pricingQuoteId !== quote.quoteId ||
    booking.check_in !== quote.stay.checkIn ||
    booking.check_out !== quote.stay.checkOut ||
    booking.currency !== quote.stay.currency ||
    booking.room_count !== quote.stay.rooms.length ||
    pricingDecimalMinor(booking.total_amount, scale) !== quote.evidence.totalMinor ||
    ["canceled", "declined", "expired", "completed", "no_show"].includes(booking.lifecycle_status)
  )
    return fail();
  const prior = (
    await client.query(
      `SELECT id,guest_booking_id,application_status,currency,discount_amount::text,metadata
    FROM booking.promo_applications WHERE property_id=$1 AND
      (guest_booking_id=$2 OR metadata->>'pricingQuoteId'=$3) FOR UPDATE`,
      [scope.propertyId, guestBookingId, quote.quoteId],
    )
  ).rows;
  if (prior.length) {
    const p = prior[0];
    if (
      prior.length !== 1 ||
      p.guest_booking_id !== booking.id ||
      p.application_status !== "applied" ||
      !isPositiveMinor(p.metadata.discountMinor) ||
      p.metadata.version !== "booking.quote-promo.v1" ||
      p.metadata.pricingQuoteId !== quote.quoteId ||
      p.currency !== quote.stay.currency ||
      pricingDecimalMinor(p.discount_amount, scale) !== p.metadata.discountMinor
    )
      return fail();
    if (!(await lockPublicPricingAuthority(client, slug))) return fail();
    return {
      kind: "applied" as const,
      applicationId: p.id as string,
      discountMinor: p.metadata.discountMinor as string,
      replayed: true,
    };
  }
  const current = await lockCurrentQuoteRevalidation(client, slug, quote.quoteId);
  if (!current) return fail();
  const { code, discounts } = current.calculation;
  if (!code || discounts.codeMinor === "0") return { kind: "not_applied" as const };
  // The existing application column is numeric(15,2). Never silently round a
  // higher-precision currency or overflow it; the acceptance transaction must fail.
  const amount = BigInt(discounts.codeMinor),
    unit = 10n ** BigInt(scale);
  const fraction = (amount % unit).toString().padStart(scale, "0").replace(/0+$/, "");
  const decimal = (amount / unit).toString() + (fraction ? `.${fraction}` : "");
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(decimal)) return fail();
  const result = await client.query(
    `WITH consumed AS (
    UPDATE booking.promo_definitions SET current_uses=current_uses+1,updated_at=clock_timestamp()
    WHERE id=$1 AND property_id=$2 AND status='active' AND is_active AND current_uses<max_uses RETURNING id
  ) INSERT INTO booking.promo_applications(property_id,guest_booking_id,promo_definition_id,promo_code,
    application_status,discount_amount,currency,metadata)
    SELECT $2,$3,id,$4,'applied',$5::numeric,$6,$7::jsonb FROM consumed RETURNING id`,
    [
      code.id,
      scope.propertyId,
      booking.id,
      code.code,
      decimal,
      quote.stay.currency,
      {
        version: "booking.quote-promo.v1",
        pricingQuoteId: quote.quoteId,
        discountMinor: discounts.codeMinor,
        promoSourceRevision: code.sourceRevision,
      },
    ],
  );
  if (result.rowCount !== 1) return fail();
  return {
    kind: "applied" as const,
    applicationId: result.rows[0].id as string,
    discountMinor: discounts.codeMinor,
    replayed: false,
  };
}
