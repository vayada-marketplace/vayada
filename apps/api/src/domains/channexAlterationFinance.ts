import { appendChannexNightlyRevenueEvidence } from "./channexBookingNightlyRevenueEvidence.js";
import { z } from "zod";
import { appendFinanceAirbnbProviderSnapshot } from "./financeAirbnbProviderSnapshot.js";
import type { ExternalRevenueEvidenceClient } from "./bookingExternalNightlyRevenueEvidence.js";
import type { ChannexAlterationNightlyPriceScope } from "../integrations/channexAlterationNightlyPrices.js";

type Identity = {
  propertyId: string;
  connectionId: string;
  bindingGeneration: string;
  providerPropertyId: string;
  providerBookingId: string;
  providerChannelId: string;
  providerRevisionId: string;
  providerRevisionAt: string;
};
type Settings = Parameters<typeof appendFinanceAirbnbProviderSnapshot>[1]["settingsEvidence"];
/** Read verified durable evidence only; never infer historic settings from current channel metadata. */
export type ChannexAirbnbFinanceSettingsPort = (
  client: ExternalRevenueEvidenceClient,
  identity: Identity,
) => Promise<(Identity & Settings) | null>;

export async function captureChannexAlterationFinance(
  client: ExternalRevenueEvidenceClient,
  input: {
    propertyId: string;
    bookingId: string;
    connectionId: string;
    bindingGeneration: string;
    providerRevisionAt: string;
    rawRevision: unknown;
    revisionScope: ChannexAlterationNightlyPriceScope;
  },
  resolve: ChannexAirbnbFinanceSettingsPort,
) {
  const outer = z.record(z.string(), z.unknown()).parse(input.rawRevision);
  const envelope = z.record(z.string(), z.unknown()).parse(outer["data"] ?? outer);
  const attributes = z.record(z.string(), z.unknown()).parse(envelope["attributes"] ?? envelope);
  const channel = z.uuid().safeParse(attributes["channel_id"]);
  if (!channel.success) throw new Error("alteration_finance_channel_unavailable");
  const identity: Identity = {
    propertyId: input.propertyId,
    connectionId: input.connectionId,
    bindingGeneration: input.bindingGeneration,
    providerPropertyId: input.revisionScope.providerPropertyId,
    providerBookingId: input.revisionScope.providerBookingId,
    providerChannelId: channel.data,
    providerRevisionId: input.revisionScope.revisionId,
    providerRevisionAt: input.providerRevisionAt,
  };
  const evidence = await resolve(client, { ...identity });
  if (
    !evidence ||
    Object.entries(identity).some(([key, value]) => evidence[key as keyof Identity] !== value)
  )
    throw new Error("alteration_finance_settings_unavailable");
  const current = (
    await client.query<{ revisionId: string }>(
      `SELECT provider_revision_id AS "revisionId" FROM finance.airbnb_current_provider_amounts
     WHERE property_id=$1 AND guest_booking_id=$2`,
      [input.propertyId, input.bookingId],
    )
  ).rows[0];
  const captured = await appendFinanceAirbnbProviderSnapshot(client, {
    propertyId: input.propertyId,
    bookingId: input.bookingId,
    previousRevisionId: current?.revisionId ?? null,
    providerRevisionAt: input.providerRevisionAt,
    settingsEvidence: evidence,
    rawRevision: input.rawRevision,
    revisionScope: input.revisionScope,
  });
  if (captured.outcome === "replayed") return;
  const canceled = attributes["status"] === "cancelled" || attributes["status"] === "canceled";
  await appendChannexNightlyRevenueEvidence(client, {
    propertyId: input.propertyId,
    bookingId: input.bookingId,
    providerBookingId: input.revisionScope.providerBookingId,
    revisionId: input.revisionScope.revisionId,
    revisionAt: input.providerRevisionAt,
    canceled,
    retainedCharges: [],
    captureEconomics: true,
    // Provider payout/guest-paid slices cannot establish gross room revenue.
    rooms: canceled
      ? []
      : input.revisionScope.rooms.map(() => ({
          checkIn: input.revisionScope.checkIn,
          checkOut: input.revisionScope.checkOut,
          days: null,
        })),
  });
}
