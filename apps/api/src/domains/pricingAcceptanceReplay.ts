import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { pricingObject } from "@vayada/domain-pms";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { decodePricingAcceptanceHistory } from "./pricingAcceptanceHistory.js";
import { parseBookingQuoteAcceptanceInput } from "./bookingQuoteAcceptanceInput.js";

/** Read completed historical acceptance before fresh pricing/expiry checks.
 * Caller owns READ COMMITTED through commit/rollback. A null result means no
 * receipt exists, not permission to write: the writer must reserve its key and
 * quote uniqueness scope, then repeat this read after any reservation wait. */
export async function replayPricingAcceptance(client: PoolClient, slug: unknown, input: unknown) {
  const unavailable = (): never => {
    throw new Error("Booking acceptance unavailable");
  };
  if (
    !pricingObject(input) ||
    typeof input.requestId !== "string" ||
    !input.requestId.length ||
    input.requestId.length > 200 ||
    input.requestId !== input.requestId.trim() ||
    /[\u0000-\u001f\u007f]/.test(input.requestId)
  )
    return unavailable();
  const scope = await lockPublicPricingAuthority(client, slug);
  if (!scope) return unavailable();
  const keyHash = createHash("sha256").update(input.requestId).digest("hex");
  const rows = (
    await client.query(
      `SELECT a.*,
      r.id AS receipt_id, r.status AS receipt_status,
      r.request_fingerprint_hash AS receipt_fingerprint,
      r.response_status_code, r.response_resource_product, r.response_resource_type, r.response_resource_id,
      b.id AS linked_booking_id, q.payload->'quote' AS linked_quote
    FROM platform.idempotency_keys r
    LEFT JOIN booking.pricing_quote_acceptances a ON a.command_receipt_id=r.id
      AND a.property_id=r.property_id AND a.organization_id=$3
    LEFT JOIN booking.guest_bookings b ON b.id=a.guest_booking_id AND b.property_id=a.property_id
    LEFT JOIN booking.pricing_quotes q ON q.id=a.pricing_quote_id
      AND q.property_id=a.property_id AND q.organization_id=a.organization_id
    WHERE r.property_id=$1 AND r.key_hash=$2 AND r.tenant_scope='property'
      AND r.operation_scope='booking' AND r.operation='booking.pricing_quote.accept'
    FOR SHARE OF r`,
      [scope.propertyId, keyHash, scope.organizationId],
    )
  ).rows;
  if (!rows.length) return null;
  if (rows.length !== 1) return unavailable();
  const row = rows[0];
  const date = (v: unknown) =>
    v instanceof Date && Number.isFinite(v.getTime()) ? v.toISOString() : v;
  const history = decodePricingAcceptanceHistory(
    {
      ...row,
      accepted_at: date(row.accepted_at),
      finance_terms_captured_at: date(row.finance_terms_captured_at),
    },
    scope.propertyId,
    scope.organizationId,
  );
  if (
    row.receipt_status !== "completed" ||
    !history ||
    row.response_status_code !== 200 ||
    row.response_resource_product !== "booking" ||
    row.response_resource_type !== "guest_booking" ||
    row.response_resource_id !== history.bookingId ||
    row.receipt_id !== history.commandReceiptId ||
    row.linked_booking_id !== history.bookingId ||
    row.receipt_fingerprint !== history.fingerprint.slice(7) ||
    !isDeepStrictEqual(row.linked_quote, history.quote)
  )
    return unavailable();
  const retry = parseBookingQuoteAcceptanceInput(input, history.quote, history.policy);
  if (
    !retry ||
    retry.requestId !== history.command.requestId ||
    retry.fingerprint !== history.fingerprint
  )
    return unavailable();
  const current = await lockPublicPricingAuthority(client, slug);
  if (!current || !isDeepStrictEqual(current, scope)) return unavailable();
  return { bookingId: history.bookingId, replayed: true as const };
}
