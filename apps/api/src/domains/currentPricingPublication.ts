import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  lockBookingPricingOfferTerms,
  lockBookingPricingTermsSource,
} from "./bookingPricingOfferTerms.js";
import { lockFinanceReplacementPricingReadiness } from "./financeReplacementPricingReadiness.js";
import { lockFinanceReplacementPricingSource } from "./financeReplacementPricingSource.js";
import { lockPmsPricingRoomScope } from "./pmsPricingRoomScope.js";
import { lockPmsReplacementPricingRoomSource } from "./pmsReplacementPricingRoomSource.js";
import { lockBookingPricingAuthority } from "./bookingPricingAuthority.js";
import { lockCurrentPmsPricingEntitlement } from "./replacementPricingAuthorization.js";
import { lockReplacementChargeCoverage } from "./replacementChargeCoverage.js";
import { readCurrentPricingSnapshot } from "./replacementPricingSnapshot.js";

/** Internal owner evidence for authorized publication/readiness orchestration.
 * Caller supplies trusted organization/property scope and owns READ COMMITTED.
 * Requires current Vayada authority and owner evidence, not a public profile.
 * This does not grant guest access or establish room/calendar/checkout readiness. */
export async function lockCurrentPricingPublication(
  client: PoolClient,
  input: { propertyId: string; organizationId: string },
) {
  const scope = await lockOwnerScope(client, input);
  if (!scope) return null;
  const { propertyId } = scope;
  const stored = await readCurrentPricingSnapshot(client, propertyId);
  if (
    !stored ||
    !stored.rooms.length ||
    Object.keys(stored.sources).length !== 3 ||
    !["room", "terms", "finance"].every((key) => typeof stored.sources[key] === "string") ||
    Object.keys(stored.ownerReferences).length !== 2 ||
    !["finance", "charges"].every((key) => typeof stored.ownerReferences[key] === "string")
  )
    return null;
  const room = await lockPmsReplacementPricingRoomSource(client, propertyId);
  if (!room || stored.sources.room !== room) return null;
  for (const configuration of stored.rooms)
    if (!(await lockPmsPricingRoomScope(client, propertyId, configuration.roomTypeId))) return null;
  const references = stored.rooms.flatMap((r) =>
    r.offers.map((o) => ({
      roomTypeId: r.roomTypeId,
      offerId: o.id,
      revision: o.termsRevision,
    })),
  );
  const terms = await lockBookingPricingOfferTerms(client, propertyId, references);
  const termsSource = await lockBookingPricingTermsSource(client, propertyId);
  if (!terms || !termsSource || stored.sources.terms !== termsSource) return null;
  const financeSource = await lockFinanceReplacementPricingSource(client, propertyId);
  if (!financeSource || stored.sources.finance !== financeSource) return null;
  const finance = await lockFinanceReplacementPricingReadiness(client, {
    propertyId,
    currency: stored.currency,
    pricingRevision: stored.revision,
    terms,
    expectedEvidenceId: stored.ownerReferences.finance,
  });
  if (finance.kind !== "ready") return null;
  const snapshot = {
    currency: stored.currency,
    rooms: stored.rooms,
    ownerReferences: stored.ownerReferences,
  };
  const charges = await lockReplacementChargeCoverage(
    client,
    propertyId,
    stored.ownerReferences.charges!,
    snapshot,
    stored.sources,
  );
  if (!charges) return null;
  // Owner locks can wait: recheck time-limited entitlements after those reads.
  if (!(await lockCurrentPmsPricingEntitlement(client, scope.organizationId, propertyId)))
    return null;
  const pmsSourceRevision =
    "booking.pms.publication.v2:" +
    createHash("sha256")
      .update(
        JSON.stringify({
          propertyId,
          organizationId: scope.organizationId,
          authorityRevision: scope.authorityRevision,
          pricingRevision: stored.revision,
          room,
          terms: termsSource,
          finance: financeSource,
        }),
      )
      .digest("hex");
  return { scope, publication: stored, terms, finance, charges, pmsSourceRevision };
}

async function lockOwnerScope(
  client: PoolClient,
  input: { propertyId: string; organizationId: string },
) {
  const uuid = (value: unknown): value is string =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  if (!uuid(input.propertyId) || !uuid(input.organizationId)) return null;
  const propertyId = input.propertyId.toLowerCase(),
    organizationId = input.organizationId.toLowerCase();
  // Inventory/authority before organization and owner sources, matching publication writers.
  const authority = await lockBookingPricingAuthority(client, propertyId);
  if (
    authority.authority !== "vayada" ||
    authority.organizationId !== organizationId ||
    !authority.revision
  )
    return null;
  if (
    !(
      await client.query(
        "SELECT id FROM identity.organizations WHERE id=$1 AND kind='hotel_group' AND status='active' FOR UPDATE",
        [organizationId],
      )
    ).rowCount
  )
    return null;
  if (
    !(
      await client.query(
        "SELECT id FROM hotel_catalog.properties WHERE id=$1 AND lifecycle_status='active' FOR SHARE",
        [propertyId],
      )
    ).rowCount
  )
    return null;
  const links = (
    await client.query(
      `SELECT product FROM identity.organization_resource_links
    WHERE organization_id=$1 AND resource_id=$2 AND status='active' AND relationship IN ('owner','operator')
      AND ((product='pms' AND resource_type='pms_property') OR (product='hotel_catalog' AND resource_type='property')) FOR SHARE`,
      [organizationId, propertyId],
    )
  ).rows;
  if (
    !links.some((row) => row.product === "pms") ||
    !links.some((row) => row.product === "hotel_catalog") ||
    !(await lockCurrentPmsPricingEntitlement(client, organizationId, propertyId))
  )
    return null;
  return { propertyId, organizationId, authorityRevision: authority.revision };
}
