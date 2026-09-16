import { z } from "zod";
import type { ExternalRevenueEvidenceClient } from "./bookingExternalNightlyRevenueEvidence.js";
import { readChannexAirbnbAlterationFinancialSnapshot } from "../integrations/channexAirbnbAlterationFinancialSnapshot.js";
import type { ChannexAlterationNightlyPriceScope } from "../integrations/channexAlterationNightlyPrices.js";

const reference = z.string().trim().min(1).max(500);
const commandSchema = z.object({
  propertyId: z.uuid(),
  bookingId: z.uuid(),
  previousRevisionId: reference.nullable(),
  providerRevisionAt: z.iso.datetime({ precision: 6 }),
  settingsEvidence: z.object({
    providerRevisionId: reference,
    providerChannelId: z.uuid(),
    reference,
    booking_amount_settings: z.enum(["Payout Amount", "Total Paid Amount"]),
    cohost_payout_calculations: z.boolean().nullable(),
  }),
});
type Command = z.infer<typeof commandSchema> & {
  revisionScope: ChannexAlterationNightlyPriceScope;
  rawRevision: unknown;
};

/** Caller owns transaction, provider acceptance and revision-bound settings verification. */
export async function appendFinanceAirbnbProviderSnapshot(
  client: ExternalRevenueEvidenceClient,
  input: Command,
) {
  const command = commandSchema.parse(input);
  const snapshot = readChannexAirbnbAlterationFinancialSnapshot(
    input.rawRevision,
    input.revisionScope,
    command.settingsEvidence,
  );
  if (command.settingsEvidence.providerRevisionId !== snapshot.revisionId)
    throw new Error("airbnb_finance_settings_revision_mismatch");
  const transaction = (
    await client.query<{ id: string; isolation: string }>(
      "SELECT txid_current()::text id,current_setting('transaction_isolation') AS isolation",
    )
  ).rows[0]!;
  if (transaction.isolation !== "read committed")
    throw new Error("airbnb_finance_transaction_unsupported");
  const booking = (
    await client.query<{
      transactionId: string;
      checkIn: string;
      checkOut: string;
      roomCount: number;
      status: string;
      amountMatches: boolean;
    }>(
      `SELECT txid_current()::text AS "transactionId",check_in::text AS "checkIn",check_out::text AS "checkOut",
       room_count AS "roomCount",lifecycle_status AS status,total_amount=$5::numeric AS "amountMatches" FROM booking.guest_bookings
     WHERE id=$1 AND property_id=$2 AND source_system='pms' AND source_booking_id=$3
       AND booking_channel='airbnb' AND currency=$4 FOR UPDATE`,
      [
        command.bookingId,
        command.propertyId,
        `channex:${command.propertyId}:${snapshot.providerBookingId}`,
        snapshot.currency,
        snapshot.providerBookingAmount,
      ],
    )
  ).rows[0];
  if (!booking || booking.transactionId !== transaction.id)
    throw new Error("airbnb_finance_booking_scope_unavailable");
  const values = [
    command.propertyId,
    command.bookingId,
    snapshot.providerPropertyId,
    snapshot.providerBookingId,
    command.settingsEvidence.providerChannelId,
    snapshot.revisionId,
    command.providerRevisionAt,
    command.settingsEvidence.reference,
    snapshot.currency,
    snapshot.amountBasis,
    snapshot.cohostPayoutCalculations,
    snapshot.providerBookingAmount,
    snapshot.otaCommission,
    JSON.stringify(snapshot),
  ];
  const replay = (
    await client.query<{ id: string; matches: boolean }>(
      `SELECT id, (provider_property_id=$3::uuid AND provider_booking_id=$4::uuid AND provider_channel_id=$5::uuid
      AND provider_revision_at=$7::timestamptz AND settings_evidence_ref=$8 AND currency=$9
      AND amount_basis=$10 AND cohost_payout_calculations IS NOT DISTINCT FROM $11::boolean
      AND provider_booking_amount IS NOT DISTINCT FROM $12::numeric AND ota_commission IS NOT DISTINCT FROM $13::numeric
      AND snapshot=$14::jsonb) AS matches FROM finance.airbnb_provider_snapshots
     WHERE property_id=$1 AND guest_booking_id=$2 AND provider_revision_id=$6`,
      values,
    )
  ).rows[0];
  if (replay) {
    if (!replay.matches) throw new Error("airbnb_finance_revision_conflict");
    return { outcome: "replayed" as const, snapshotId: replay.id };
  }
  if (
    snapshot.replacement === "cancellation"
      ? booking.status !== "canceled"
      : booking.status !== "confirmed" ||
        !booking.amountMatches ||
        booking.checkIn !== snapshot.checkIn ||
        booking.checkOut !== snapshot.checkOut ||
        booking.roomCount !== snapshot.rooms.length
  )
    throw new Error("airbnb_finance_booking_stay_mismatch");
  const current = (
    await client.query<{
      revisionId: string;
      newer: boolean;
      sameSource: boolean;
    }>(
      `SELECT provider_revision_id AS "revisionId",provider_revision_at<$6::timestamptz AS newer,
      (provider_property_id=$3::uuid AND provider_booking_id=$4::uuid AND provider_channel_id=$5::uuid
       AND currency=$7 AND amount_basis=$8 AND cohost_payout_calculations IS NOT DISTINCT FROM $9::boolean) AS "sameSource"
     FROM finance.airbnb_current_provider_amounts WHERE property_id=$1 AND guest_booking_id=$2`,
      [
        command.propertyId,
        command.bookingId,
        snapshot.providerPropertyId,
        snapshot.providerBookingId,
        command.settingsEvidence.providerChannelId,
        command.providerRevisionAt,
        snapshot.currency,
        snapshot.amountBasis,
        snapshot.cohostPayoutCalculations,
      ],
    )
  ).rows[0];
  if (
    (current?.revisionId ?? null) !== command.previousRevisionId ||
    (current && (!current.newer || !current.sameSource))
  )
    throw new Error("airbnb_finance_previous_revision_conflict");
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO finance.airbnb_provider_snapshots(property_id,guest_booking_id,provider_property_id,
      provider_booking_id,provider_channel_id,provider_revision_id,provider_revision_at,settings_evidence_ref,
      currency,amount_basis,cohost_payout_calculations,provider_booking_amount,ota_commission,snapshot)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    values,
  );
  return { outcome: "appended" as const, snapshotId: inserted.rows[0]!.id };
}
