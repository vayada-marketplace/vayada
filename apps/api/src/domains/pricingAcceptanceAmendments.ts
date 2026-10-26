import { isDeepStrictEqual } from "node:util";
import { parseStoredPricingQuote, type StoredPricingQuote } from "@vayada/domain-booking";
import {
  parsePmsInventoryReservationBundle,
  type PmsInventoryReservationBundle,
} from "@vayada/domain-pms";
import type { PoolClient } from "pg";
import { decodePricingAcceptanceHistory } from "./pricingAcceptanceHistory.js";

type AcceptedPricingHistory = NonNullable<ReturnType<typeof decodePricingAcceptanceHistory>>;

/** A pricing-v2 stay's priced state now: its immutable acceptance, with the latest date-change
 * amendment's quote and inventory bundle when the dates changed (VAY-2110). Guest consent,
 * finance terms and the property time zone stay the acceptance's; an amendment may change
 * only the dates and prices, so the rooms and their booked terms are the accepted ones. */
export type CurrentPricingAcceptance = {
  acceptance: AcceptedPricingHistory;
  /** 0 for the acceptance itself, else the amendment's revision. */
  revision: number;
  /** The booking edit revision the PMS adoption guard expects. */
  editRevision: number;
  pricingQuoteId: string;
  quote: StoredPricingQuote;
  reservation: PmsInventoryReservationBundle;
};

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);

export async function loadCurrentPricingAcceptance(
  client: Pick<PoolClient, "query">,
  input: { propertyId: string; guestBookingId: string },
): Promise<CurrentPricingAcceptance | null> {
  const row = (
    await client.query(
      `SELECT * FROM booking.pricing_quote_acceptances
       WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid`,
      [input.propertyId, input.guestBookingId],
    )
  ).rows[0];
  if (!row) return null;
  const acceptance = decodePricingAcceptanceHistory(
    {
      ...row,
      accepted_at: iso(row.accepted_at),
      finance_terms_captured_at: iso(row.finance_terms_captured_at),
    },
    input.propertyId,
    String(row.organization_id),
  );
  if (!acceptance) return null;
  const amendment = (
    await client.query(
      `SELECT revision, edit_revision, pricing_quote_id::text, quote_snapshot,
         inventory_reservation_bundle
       FROM booking.pricing_acceptance_amendments
       WHERE acceptance_id=$1::uuid AND property_id=$2::uuid AND guest_booking_id=$3::uuid
       ORDER BY revision DESC
       LIMIT 1`,
      [acceptance.id, input.propertyId, input.guestBookingId],
    )
  ).rows[0];
  if (!amendment)
    return {
      acceptance,
      revision: 0,
      editRevision: 0,
      pricingQuoteId: acceptance.quote.quoteId,
      quote: acceptance.quote,
      reservation: acceptance.reservation,
    };
  const quote = parseStoredPricingQuote(amendment.quote_snapshot);
  const reservation = parsePmsInventoryReservationBundle(amendment.inventory_reservation_bundle);
  if (
    !quote ||
    !reservation ||
    !isDeepStrictEqual(reservation, amendment.inventory_reservation_bundle) ||
    quote.quoteId !== amendment.pricing_quote_id ||
    quote.stay.propertyId !== input.propertyId ||
    !Number.isInteger(amendment.revision) ||
    !Number.isInteger(amendment.edit_revision)
  )
    return null;
  return {
    acceptance,
    revision: amendment.revision,
    editRevision: amendment.edit_revision,
    pricingQuoteId: amendment.pricing_quote_id,
    quote,
    reservation,
  };
}
