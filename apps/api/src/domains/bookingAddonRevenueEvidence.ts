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

export type AddonRevenueRefundTarget = {
  evidenceId: string;
  recognizedOn: string;
  availableAmount: string;
  currency: string;
};

export type AddonRevenueCorrectionTarget = AddonRevenueRefundTarget & {
  purchasedAmount: string;
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

export async function loadAddonRevenueRefundTargets(
  transaction: BookingAddonRevenueEvidenceClient,
  input: {
    propertyId: string;
    guestBookingId: string;
    currency: string;
    evidenceIds: readonly string[];
  },
): Promise<AddonRevenueRefundTarget[]> {
  const result = await transaction.query<AddonRevenueRefundTarget>(
    `WITH state AS (
       SELECT evidence.id,evidence.recognized_on,evidence.currency,
         COALESCE(SUM(evidence.gross_amount) OVER (PARTITION BY addon_selection_id),0) AS available,
         row_number() OVER (PARTITION BY addon_selection_id
           ORDER BY source_revision DESC,created_at DESC,id DESC) AS position
       FROM booking.addon_revenue_evidence evidence
       WHERE property_id=$2::uuid AND guest_booking_id=$3::uuid AND currency=$4
     ) SELECT id::text AS "evidenceId",recognized_on::text AS "recognizedOn",
       available::text AS "availableAmount",trim(currency) AS currency
     FROM state WHERE id=ANY($1::uuid[]) AND position=1 AND available>0`,
    [input.evidenceIds, input.propertyId, input.guestBookingId, input.currency],
  );
  return result.rows;
}

export async function appendAddonRevenueRefundEvidence(
  transaction: BookingAddonRevenueEvidenceClient,
  input: {
    propertyId: string;
    guestBookingId: string;
    recognizedOn: string;
    commandKeyHash: string;
    refunds: readonly { targetEvidenceId: string; grossAmount: string }[];
  },
): Promise<void> {
  await appendAddonRevenueAdjustments(transaction, {
    ...input,
    event: "refund",
    commandKeyPrefix: `pms-refund:${input.commandKeyHash}:addon:`,
    adjustments: input.refunds,
  });
}

export async function loadAddonRevenueCorrectionTargets(
  transaction: BookingAddonRevenueEvidenceClient,
  input: {
    propertyId: string;
    guestBookingId: string;
    currency: string;
    evidenceIds: readonly string[];
  },
): Promise<AddonRevenueCorrectionTarget[]> {
  const result = await transaction.query<AddonRevenueCorrectionTarget>(
    `WITH state AS (
       SELECT evidence.id,evidence.addon_selection_id,evidence.recognized_on,evidence.currency,
         COALESCE(SUM(evidence.gross_amount) OVER (PARTITION BY evidence.addon_selection_id),0) AS available,
         first_value(evidence.economic_event) OVER (PARTITION BY evidence.addon_selection_id
           ORDER BY evidence.source_revision) AS root_event,
         row_number() OVER (PARTITION BY evidence.addon_selection_id
           ORDER BY evidence.source_revision DESC,evidence.created_at DESC,evidence.id DESC) AS position
       FROM booking.addon_revenue_evidence evidence
       WHERE evidence.property_id=$2::uuid AND evidence.guest_booking_id=$3::uuid
         AND evidence.currency=$4
     ) SELECT state.id::text AS "evidenceId",state.recognized_on::text AS "recognizedOn",
       state.available::text AS "availableAmount",trim(state.currency) AS currency,
       selection.total_amount::text AS "purchasedAmount"
     FROM state JOIN booking.booking_addon_selections selection
       ON selection.id=state.addon_selection_id AND selection.property_id=$2::uuid
     WHERE state.id=ANY($1::uuid[]) AND state.position=1 AND state.root_event='fulfillment'`,
    [input.evidenceIds, input.propertyId, input.guestBookingId, input.currency],
  );
  return result.rows;
}

export async function appendAddonRevenueCorrectionEvidence(
  transaction: BookingAddonRevenueEvidenceClient,
  input: {
    propertyId: string;
    guestBookingId: string;
    recognizedOn: string;
    commandKeyHash: string;
    corrections: readonly { targetEvidenceId: string; grossAmount: string }[];
  },
): Promise<void> {
  await appendAddonRevenueAdjustments(transaction, {
    ...input,
    event: "correction",
    commandKeyPrefix: `pms-price-correction:${input.commandKeyHash}:addon:`,
    adjustments: input.corrections,
  });
}

async function appendAddonRevenueAdjustments(
  transaction: BookingAddonRevenueEvidenceClient,
  input: {
    propertyId: string;
    guestBookingId: string;
    recognizedOn: string;
    event: "refund" | "correction";
    commandKeyPrefix: string;
    adjustments: readonly { targetEvidenceId: string; grossAmount: string }[];
  },
): Promise<void> {
  if (input.adjustments.length === 0) return;
  const inserted = await transaction.query(
    `INSERT INTO booking.addon_revenue_evidence
       (addon_selection_id,property_id,guest_booking_id,recognized_on,quantity,currency,
        gross_amount,ownership_kind,partner_commission_rate,economic_event,evidence_quality,
        source_revision,corrects_evidence_id,command_key)
     SELECT target.addon_selection_id,target.property_id,target.guest_booking_id,$3::date,
       target.quantity,target.currency,line."grossAmount"::numeric,target.ownership_kind,
       target.partner_commission_rate,$5,'exact',target.source_revision+1,target.id,
       $6 || target.addon_selection_id::text || ':v' || (target.source_revision+1)::text
     FROM booking.addon_revenue_evidence target
     JOIN jsonb_to_recordset($4::jsonb) AS line("targetEvidenceId" text,"grossAmount" text)
       ON target.id=line."targetEvidenceId"::uuid
     WHERE target.property_id=$1::uuid AND target.guest_booking_id=$2::uuid`,
    [
      input.propertyId,
      input.guestBookingId,
      input.recognizedOn,
      JSON.stringify(input.adjustments),
      input.event,
      input.commandKeyPrefix,
    ],
  );
  if (inserted.rowCount !== input.adjustments.length)
    throw new BookingAddonRevenueEvidenceError("Add-on adjustment target is unavailable.");
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
