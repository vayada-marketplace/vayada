import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  lockBookingPricingOfferTerms,
  lockBookingPricingTermsSource,
} from "./bookingPricingOfferTerms.js";
import { lockCurrentPricingPublication } from "./currentPricingPublication.js";
import { lockFinanceReplacementPricingReadiness } from "./financeReplacementPricingReadiness.js";
import { lockFinanceReplacementPricingSource } from "./financeReplacementPricingSource.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { lockPmsReplacementPricingRoomSource } from "./pmsReplacementPricingRoomSource.js";
import { owningOrganization } from "./publicPricingAuthority.js";
import {
  lockReplacementChargeDeclaration,
  replacementChargeFingerprint,
} from "./replacementChargeDeclarations.js";
import {
  readCurrentPricingSnapshot,
  type PricingStorageSnapshot,
  type StoredPricingRevision,
} from "./replacementPricingSnapshot.js";

export type PricingPaymentRepublish = { propertyId: string } & (
  | { outcome: "republished"; from: number; revision: number }
  /** The published prices still match the payment setup: nothing to do. */
  | { outcome: "current" }
  | {
      outcome: "skipped";
      reason:
        | "not_published"
        | "unreadable"
        /** Rooms or rate terms changed since too: publishing them is the hotel's save. */
        | "room_or_terms_changed"
        | "no_owner"
        /** The new payment setup can't take these prices at all (e.g. no way to pay). */
        | "finance_unavailable"
        | "charges_unavailable"
        /** The copy would not pass the public read; nothing was written. */
        | "not_servable";
      financeReason?: string;
    }
  | { outcome: "lock_timeout" }
);

const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const FIXED_CHARGE_POLICY = "booking.fixed-charge-policy.v1:";
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

/** VAY-2304: after a change to a hotel's payment setup (Vayada card on or off, its payment methods,
 * its Stripe account, or a release that changes the Finance fingerprint), publish its last
 * published prices again with the new payment terms, as the system. Only the published head is
 * copied: its rooms and the rate terms revisions it references, never a draft or a staged term.
 * Runs in its own transaction after the payment change has committed, taking the locks of a
 * hotel's "Save prices" in the same order, so the two serialize. The copy must pass the public
 * read (lockCurrentPricingPublication) before it commits. */
export async function republishPricingAfterPaymentChange(
  pool: Pool,
  propertyId: string,
): Promise<PricingPaymentRepublish> {
  if (!uuid(propertyId)) return { propertyId, outcome: "skipped", reason: "not_published" };
  propertyId = propertyId.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await republish(client, propertyId);
    await client.query(result.outcome === "republished" ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: unknown }).code === "55P03")
      return { propertyId, outcome: "lock_timeout" };
    throw error;
  } finally {
    client.release();
  }
}

async function republish(client: PoolClient, propertyId: string): Promise<PricingPaymentRepublish> {
  const skipped = (
    reason: Extract<PricingPaymentRepublish, { outcome: "skipped" }>["reason"],
    financeReason?: string,
  ): PricingPaymentRepublish => ({
    propertyId,
    outcome: "skipped",
    reason,
    ...(financeReason ? { financeReason } : {}),
  });
  // The pricing lock first, as every price save and the public read take it.
  await lockPmsInventoryMutationScope(client, propertyId);
  let stored: StoredPricingRevision | null;
  try {
    stored = await readCurrentPricingSnapshot(client, propertyId);
  } catch {
    return skipped("unreadable");
  }
  if (!stored) return skipped("not_published");
  const room = await lockPmsReplacementPricingRoomSource(client, propertyId, {
    revision: stored.revision,
    roomTypeIds: stored.rooms.map((r) => r.roomTypeId),
  });
  const termsSource = await lockBookingPricingTermsSource(client, propertyId);
  if (!room || room !== stored.sources.room || !termsSource || termsSource !== stored.sources.terms)
    return skipped("room_or_terms_changed");
  const terms = await lockBookingPricingOfferTerms(
    client,
    propertyId,
    stored.rooms.flatMap((r) =>
      r.offers.map((o) => ({ roomTypeId: r.roomTypeId, offerId: o.id, revision: o.termsRevision })),
    ),
  );
  if (!terms) return skipped("room_or_terms_changed");
  const finance = await lockFinanceReplacementPricingSource(client, propertyId);
  if (!finance) return skipped("finance_unavailable");
  if (finance === stored.sources.finance) {
    // Readiness can also move without the source, e.g. an approval that takes effect later.
    const published = await lockFinanceReplacementPricingReadiness(client, {
      propertyId,
      currency: stored.currency,
      pricingRevision: stored.revision,
      terms,
      expectedEvidenceId: stored.ownerReferences.finance,
    });
    if (published.kind === "ready") return { propertyId, outcome: "current" };
    if (published.reason !== "stale") return skipped("finance_unavailable", published.reason);
  }
  const organizationId = await owningOrganization(client, propertyId);
  if (!organizationId) return skipped("no_owner");
  const revision = stored.revision + 1;
  const readiness = await lockFinanceReplacementPricingReadiness(client, {
    propertyId,
    currency: stored.currency,
    pricingRevision: revision,
    terms,
  });
  if (readiness.kind !== "ready") return skipped("finance_unavailable", readiness.reason);
  // The sources a hotel's save records: every current room, as lockReplacementPricingSources.
  const newRoom = await lockPmsReplacementPricingRoomSource(client, propertyId);
  if (!newRoom) return skipped("room_or_terms_changed");
  const sources = { room: newRoom, terms: termsSource, finance };
  const copy: PricingStorageSnapshot = {
    currency: stored.currency,
    rooms: stored.rooms.map((r) => ({ ...r, revision })),
    ownerReferences: { finance: readiness.evidenceId },
  };
  const requestId = `pricing.v2.payment-republish:${revision}`;
  const charges = await carryCharges(client, propertyId, stored, copy, sources, requestId);
  if (!charges) return skipped("charges_unavailable");
  const ownerReferences = { finance: readiness.evidenceId, charges };
  await client.query(
    `INSERT INTO pms.pricing_v2_revisions (property_id, revision, currency, source_revisions,
       owner_references, request_id, request_hash, actor_type, republished_from, room_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'system', $8, $9)`,
    [
      propertyId,
      revision,
      copy.currency,
      canonical(sources),
      canonical(ownerReferences),
      requestId,
      hash({ propertyId, from: stored.revision, revision, sources, ownerReferences }),
      stored.revision,
      copy.rooms.length,
    ],
  );
  for (const r of copy.rooms)
    await client.query(
      `INSERT INTO pms.pricing_v2_rooms (property_id, revision, room_type_id, currency, configuration)
       VALUES ($1, $2, $3, $4, $5)`,
      [propertyId, revision, r.roomTypeId, copy.currency, JSON.stringify(r)],
    );
  await client.query(
    "UPDATE pms.pricing_v2_heads SET revision = $2 WHERE property_id = $1 AND revision = $3",
    [propertyId, revision, stored.revision],
  );
  await effects(client, propertyId, requestId, revision, stored.revision);
  const servable = await lockCurrentPricingPublication(client, { propertyId, organizationId });
  if (!servable || servable.publication.revision !== revision) return skipped("not_servable");
  return { propertyId, outcome: "republished", from: stored.revision, revision };
}

/** A fixed-charge policy reference stays (the public read checks it is still current). The
 * hotel's "all mandatory charges included" declaration was made for exactly these prices; its
 * fingerprint binds the payment source, so the system carries it onto the copy, pointing at the
 * hotel's own declaration. */
async function carryCharges(
  client: PoolClient,
  propertyId: string,
  stored: StoredPricingRevision,
  copy: PricingStorageSnapshot,
  sources: Record<string, string>,
  requestId: string,
): Promise<string | null> {
  const reference = stored.ownerReferences.charges;
  if (!reference) return null;
  if (reference.startsWith(FIXED_CHARGE_POLICY)) return reference;
  const published = {
    currency: stored.currency,
    rooms: stored.rooms,
    ownerReferences: stored.ownerReferences,
  };
  const declared = await lockReplacementChargeDeclaration(
    client,
    propertyId,
    reference,
    published,
    stored.sources,
  );
  const fingerprint = replacementChargeFingerprint(propertyId, copy, sources);
  if (!declared || !fingerprint) return null;
  const hotel = (
    await client.query(
      `SELECT COALESCE(carried_from, id)::text AS id FROM pms.pricing_v2_charge_declarations
       WHERE property_id = $1 AND id = $2`,
      [propertyId, declared.id],
    )
  ).rows[0].id as string;
  const id = randomUUID();
  await client.query(
    `INSERT INTO pms.pricing_v2_charge_declarations (id, property_id, fingerprint, declaration,
       request_id, request_hash, actor_type, carried_from)
     VALUES ($1, $2, $3, $4, $5, $6, 'system', $7)`,
    [
      id,
      propertyId,
      fingerprint,
      declared.declaration,
      requestId,
      hash({ propertyId, requestId, fingerprint, carriedFrom: hotel }),
      hotel,
    ],
  );
  return id;
}

/** The events of a hotel's save (replacementPricingStore), with the system as actor. */
async function effects(
  client: PoolClient,
  propertyId: string,
  requestId: string,
  revision: number,
  from: number,
) {
  const key = `pricing.v2:${propertyId}:pricing.v2.revised:${requestId}`;
  const detail = { republishedFrom: from, reason: "payment_setup_changed" };
  const event = (
    await client.query(
      `INSERT INTO platform.domain_events (source_system, event_key, event_type, occurred_at,
         tenant_scope, property_id, resource_product, resource_type, resource_id, actor_type, payload)
       VALUES ('pms', $1, 'pricing.v2.revised', now(), 'property', $2::uuid, 'pms',
         'pricing_revision', $2::text, 'system', $3) RETURNING id`,
      [key, propertyId, JSON.stringify({ revision, ...detail })],
    )
  ).rows[0].id;
  await client.query(
    `INSERT INTO platform.product_audit_events (audit_key, product, action, occurred_at,
       tenant_scope, property_id, actor_type, target_resource_product, target_resource_type,
       target_resource_id, domain_event_id, audit_metadata)
     VALUES ($1, 'pms', 'pricing.v2.revised', now(), 'property', $2::uuid, 'system', 'pms',
       'pricing_revision', $2::text, $3, $4::jsonb)`,
    [key, propertyId, event, JSON.stringify(detail)],
  );
  // New prices also refresh the public offer days (VAY-2123).
  await client.query(
    `INSERT INTO platform.outbox_events (domain_event_id, outbox_key, destination, event_type,
       tenant_scope, property_id, resource_product, resource_type, resource_id, payload)
     VALUES ($1, $2, 'pricing.v2', 'pricing.v2.revised', 'property', $3::uuid, 'pms',
         'pricing_revision', $3::text, $4),
       ($1, $2, 'distribution.inventory-projection', 'pms.inventory.projection_refresh_requested',
         'property', $3::uuid, 'pms', 'pricing_revision', $3::text, $4)`,
    [event, key, propertyId, JSON.stringify({ revision })],
  );
}
