import type { QueryResult, QueryResultRow } from "pg";

export type BookingAddonRevenueEvidenceClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

type PurchasedAddOn = {
  selectionId: string;
  serviceDate: string | null;
  checkIn: string;
  quantity: number;
  currency: string;
  totalAmount: string;
  ownershipKind: "property" | "partner";
  partnerCommissionRate: string | null;
};

export class BookingAddonRevenueEvidenceError extends Error {}

export async function appendCheckoutAddonRevenueEvidence(
  transaction: BookingAddonRevenueEvidenceClient,
  input: {
    propertyId: string;
    guestBookingId: string;
    fulfilledSelectionIds: readonly string[];
    commandKeyHash: string;
  },
): Promise<void> {
  await appendAddonRevenueEvidence(transaction, {
    ...input,
    commandKey: `pms-checkout:${input.commandKeyHash}`,
  });
}

export async function appendMissingAddonRevenueEvidence(
  transaction: BookingAddonRevenueEvidenceClient,
  input: {
    propertyId: string;
    guestBookingId: string;
    commandKey: string;
  },
): Promise<void> {
  await appendAddonRevenueEvidence(transaction, { ...input, fulfilledSelectionIds: [] });
}

async function appendAddonRevenueEvidence(
  transaction: BookingAddonRevenueEvidenceClient,
  input: {
    propertyId: string;
    guestBookingId: string;
    fulfilledSelectionIds: readonly string[];
    commandKey: string;
  },
): Promise<void> {
  const purchased = await transaction.query<PurchasedAddOn>(
    `SELECT selection.id::text AS "selectionId", selection.service_date::text AS "serviceDate",
       booking.check_in::text AS "checkIn", selection.quantity,
       trim(selection.currency) AS currency, selection.total_amount::text AS "totalAmount",
       selection.ownership_kind_snapshot AS "ownershipKind",
       selection.partner_commission_rate_snapshot::text AS "partnerCommissionRate"
     FROM booking.guest_bookings booking
     JOIN booking.booking_addon_selections selection
       ON selection.property_id=booking.property_id AND selection.guest_booking_id=booking.id
      AND selection.edit_revision=booking.edit_revision
     WHERE booking.property_id=$1::uuid AND booking.id=$2::uuid
     ORDER BY selection.id
     FOR SHARE OF booking,selection`,
    [input.propertyId, input.guestBookingId],
  );
  const activeIds = new Set(purchased.rows.map(({ selectionId }) => selectionId));
  if (input.fulfilledSelectionIds.some((selectionId) => !activeIds.has(selectionId))) {
    throw new BookingAddonRevenueEvidenceError(
      "fulfilledAddonSelectionIds must reference active add-ons for this booking.",
    );
  }
  const fulfilled = new Set(input.fulfilledSelectionIds);
  for (const selection of purchased.rows) {
    const isFulfilled = fulfilled.has(selection.selectionId);
    await transaction.query(
      `INSERT INTO booking.addon_revenue_evidence
        (addon_selection_id,property_id,guest_booking_id,recognized_on,quantity,currency,
         gross_amount,ownership_kind,partner_commission_rate,economic_event,evidence_quality,
         source_revision,command_key)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::date,$5,$6,$7::numeric,$8,$9::numeric,$10,$11,1,$12)`,
      [
        selection.selectionId,
        input.propertyId,
        input.guestBookingId,
        selection.serviceDate ?? selection.checkIn,
        selection.quantity,
        selection.currency,
        isFulfilled ? selection.totalAmount : null,
        selection.ownershipKind,
        selection.partnerCommissionRate,
        isFulfilled ? "fulfillment" : "missing_fulfillment",
        isFulfilled ? (selection.serviceDate ? "exact" : "inferred") : "missing",
        `${input.commandKey}:addon:${selection.selectionId}:v1`,
      ],
    );
  }
}
