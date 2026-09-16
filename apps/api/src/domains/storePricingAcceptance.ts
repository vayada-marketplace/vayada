import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { decodePricingAcceptanceHistory } from "./pricingAcceptanceHistory.js";
import { replayPricingAcceptance } from "./pricingAcceptanceReplay.js";
import type { preparePricingAcceptance } from "./preparePricingAcceptance.js";
import type { stagePricingBookingLifecycle } from "./pricingBookingLifecycle.js";
import type { stagePricingBookingRevenue } from "./pricingBookingRevenue.js";

type Prepared = Extract<Awaited<ReturnType<typeof preparePricingAcceptance>>, { kind: "fresh" }>;
/** After draft/lifecycle/revenue staging, using their unchanged results on the
 * SAME retained READ COMMITTED transaction. Completes the receipt and appends
 * immutable acceptance; no commit. Caller must stage remaining outbox writes and
 * run finishPricingAcceptance after ALL blocking work, or roll back everything.
 * Completed command replay belongs before all fresh preparation and mutation. */
export async function storePricingAcceptance(
  client: PoolClient,
  slug: unknown,
  prepared: Prepared,
  lifecycle: Awaited<ReturnType<typeof stagePricingBookingLifecycle>>,
  revenue: Awaited<ReturnType<typeof stagePricingBookingRevenue>>,
) {
  const fail = (): never => {
    throw new Error("Booking acceptance unavailable");
  };
  const { current, disclosure, command, finance, commandReceiptId } = prepared;
  const scope = await lockPublicPricingAuthority(client, slug);
  const quote = current.quote;
  if (
    !scope ||
    !isDeepStrictEqual(scope, current.scope) ||
    !isDeepStrictEqual(scope, finance.scope) ||
    prepared.kind !== "fresh" ||
    !isDeepStrictEqual(quote, disclosure.quote) ||
    quote.acceptanceMode !== "instant" ||
    quote.paymentMethod !== "pay_at_property" ||
    lifecycle.lifecycleStatus !== "confirmed" ||
    lifecycle.hostResponseDeadlineAt !== null ||
    revenue.bookingId !== lifecycle.bookingId ||
    revenue.roomNights !== quote.rooms.reduce((n, r) => n + r.nights.length, 0)
  )
    return fail();
  const booking = (
    await client.query(
      `SELECT lifecycle_status,payment_status,edit_revision,booking_metadata,billing_plan_snapshot,
    commission_terms_snapshot,finance_terms_captured_at FROM booking.guest_bookings
    WHERE id=$1 AND property_id=$2 FOR UPDATE`,
      [lifecycle.bookingId, scope.propertyId],
    )
  ).rows[0];
  const iso = (v: unknown) =>
    v instanceof Date && Number.isFinite(v.getTime()) ? v.toISOString() : v;
  const metadata = booking?.booking_metadata;
  if (
    !booking ||
    booking.lifecycle_status !== "confirmed" ||
    booking.payment_status !== "unpaid" ||
    booking.edit_revision !== 0 ||
    metadata?.targetSource !== "pricing_quote_draft" ||
    metadata.pricingQuoteId !== quote.quoteId ||
    metadata.requestFingerprint !== command.fingerprint ||
    !isDeepStrictEqual(metadata.pricingSelections, quote.stay.rooms) ||
    !isDeepStrictEqual(metadata.inventoryReservation, lifecycle.inventoryReservation) ||
    booking.billing_plan_snapshot !== finance.billingPlanSnapshot ||
    !isDeepStrictEqual(booking.commission_terms_snapshot, finance.commissionTermsSnapshot) ||
    iso(booking.finance_terms_captured_at) !== finance.financeTermsCapturedAt
  )
    return fail();
  const { fingerprint, ...normalizedCommand } = command;
  const keyHash = createHash("sha256").update(command.requestId).digest("hex");
  const completed = await client.query(
    `UPDATE platform.idempotency_keys SET status='completed',completed_at=clock_timestamp(),last_seen_at=clock_timestamp(),
      response_status_code=200,response_resource_product='booking',response_resource_type='guest_booking',response_resource_id=$5
    WHERE id=$1 AND property_id=$2 AND tenant_scope='property' AND operation_scope='booking'
      AND operation='booking.pricing_quote.accept' AND key_hash=$3 AND request_fingerprint_hash=$4
      AND status='in_progress' RETURNING id`,
    [commandReceiptId, scope.propertyId, keyHash, fingerprint.slice(7), lifecycle.bookingId],
  );
  if (completed.rows.length !== 1) return fail();
  const row = (
    await client.query(
      `INSERT INTO booking.pricing_quote_acceptances
    (property_id,organization_id,pricing_quote_id,guest_booking_id,command_receipt_id,
    request_id,key_hash,request_fingerprint_hash,quote_snapshot,disclosure_json,guest_policy_source_revision,
    disclosure_hash,acceptance_command,inventory_reservation_bundle,billing_plan_snapshot,
    commission_terms_snapshot,finance_terms_captured_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [
        scope.propertyId,
        scope.organizationId,
        quote.quoteId,
        lifecycle.bookingId,
        commandReceiptId,
        command.requestId,
        keyHash,
        fingerprint.slice(7),
        quote,
        disclosure.disclosureJson,
        disclosure.policy.sourceRevision,
        disclosure.policy.disclosureHash,
        normalizedCommand,
        lifecycle.inventoryReservation,
        finance.billingPlanSnapshot,
        finance.commissionTermsSnapshot,
        finance.financeTermsCapturedAt,
      ],
    )
  ).rows[0];
  const history =
    row &&
    decodePricingAcceptanceHistory(
      {
        ...row,
        accepted_at: iso(row.accepted_at),
        finance_terms_captured_at: iso(row.finance_terms_captured_at),
      },
      scope.propertyId,
      scope.organizationId,
    );
  if (
    !history ||
    history.commandReceiptId !== commandReceiptId ||
    history.bookingId !== lifecycle.bookingId
  )
    return fail();
  // Reuse the historical reader to verify exact stored quote and completed receipt links.
  const replay = await replayPricingAcceptance(client, slug, normalizedCommand);
  if (
    !replay ||
    replay.bookingId !== lifecycle.bookingId ||
    !isDeepStrictEqual(await lockPublicPricingAuthority(client, slug), scope)
  )
    return fail();
  return { bookingId: history.bookingId, acceptanceId: history.id, acceptedAt: history.acceptedAt };
}
