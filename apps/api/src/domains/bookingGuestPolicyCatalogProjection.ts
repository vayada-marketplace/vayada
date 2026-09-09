import {
  BOOKING_GUEST_POLICY_CHANGED_EVENT_TYPE,
  BOOKING_GUEST_POLICY_OUTBOX_DESTINATION,
  BOOKING_GUEST_POLICY_RESOURCE_TYPE,
  type BookingGuestPolicyCatalogProjectionPort,
} from "@vayada/domain-booking";
import { type QueryResult, type QueryResultRow } from "pg";

type CatalogProjectionClient = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows">>;
  release(): void;
};

export function createPgBookingGuestPolicyCatalogProjectionPort(config: {
  pool: { connect(): Promise<CatalogProjectionClient> };
}): BookingGuestPolicyCatalogProjectionPort {
  return Object.freeze({
    async projectApprovedGuestPolicy(
      input: Parameters<BookingGuestPolicyCatalogProjectionPort["projectApprovedGuestPolicy"]>[0],
    ) {
      const { outboxEventId, projection } = input;
      const expectedProfileRevision = profileRevision(projection.catalogProfileSourceRevision);
      if (expectedProfileRevision === null) return Object.freeze({ outcome: "malformed" as const });
      const client = await config.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '5s'");
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext('booking.guest_policy'), hashtext($1::uuid::text))`,
          [projection.propertyId],
        );
        const source = await client.query<{ profileRevision: string | number }>(
          `SELECT property.profile_revision AS "profileRevision"
             FROM hotel_catalog.properties property
             JOIN platform.outbox_events outbox
               ON outbox.id = $1::uuid
              AND outbox.property_id = property.id
              AND outbox.destination = $5
              AND outbox.event_type = $6
              AND outbox.resource_product = 'booking'
              AND outbox.resource_type = $7
             JOIN booking.guest_policy_revisions revision
               ON revision.outbox_event_id = outbox.id
              AND revision.revision_id::text = outbox.resource_id
              AND revision.property_id = property.id
              AND revision.guest_policy_revision = $3
              AND revision.catalog_profile_source_revision = $4
              AND revision.bundle_hash = $8
              AND revision.source_fingerprint = $9
             JOIN booking.current_working_guest_policy_revisions current
               ON current.property_id = revision.property_id
              AND current.organization_id = revision.organization_id
              AND current.revision_id = revision.revision_id
              AND current.guest_policy_revision = revision.guest_policy_revision
            WHERE property.id = $2::uuid
            FOR UPDATE OF property`,
          [
            outboxEventId,
            projection.propertyId,
            projection.guestPolicyRevision,
            projection.catalogProfileSourceRevision,
            BOOKING_GUEST_POLICY_OUTBOX_DESTINATION,
            BOOKING_GUEST_POLICY_CHANGED_EVENT_TYPE,
            BOOKING_GUEST_POLICY_RESOURCE_TYPE,
            projection.bundleHash,
            projection.sourceFingerprint,
          ],
        );
        const observed = positiveRevision(source.rows[0]?.profileRevision);
        if (observed === null) return await malformed(client);
        if (observed !== expectedProfileRevision) {
          await client.query("ROLLBACK");
          return Object.freeze({
            outcome: "source_revision_conflict" as const,
            observedCatalogProfileRevision: `profile:${observed}`,
          });
        }
        await client.query(
          `INSERT INTO hotel_catalog.property_policy_summaries (
             property_id, check_in_time, check_in_until, check_out_from,
             check_out_time, policy_source_owner, updated_at
           ) VALUES ($1::uuid, $2::time, $3::time, $4::time, $5::time, 'booking', now())
           ON CONFLICT (property_id) DO UPDATE
           SET check_in_time = EXCLUDED.check_in_time,
               check_in_until = EXCLUDED.check_in_until,
               check_out_from = EXCLUDED.check_out_from,
               check_out_time = EXCLUDED.check_out_time,
               policy_source_owner = 'booking',
               updated_at = now()
           WHERE ROW(
             hotel_catalog.property_policy_summaries.check_in_time,
             hotel_catalog.property_policy_summaries.check_in_until,
             hotel_catalog.property_policy_summaries.check_out_from,
             hotel_catalog.property_policy_summaries.check_out_time,
             hotel_catalog.property_policy_summaries.policy_source_owner
           ) IS DISTINCT FROM ROW(
             EXCLUDED.check_in_time, EXCLUDED.check_in_until, EXCLUDED.check_out_from,
             EXCLUDED.check_out_time, EXCLUDED.policy_source_owner
           )`,
          [
            projection.propertyId,
            projection.policy.checkInTime,
            projection.policy.checkInUntil ?? null,
            projection.policy.checkOutFrom ?? null,
            projection.policy.checkOutTime,
          ],
        );
        const owner = await client.query<{ revision: string | number }>(
          `SELECT revision FROM hotel_catalog.property_owner_revisions
            WHERE property_id = $1::uuid AND owner_key = 'hotel_catalog.policy'`,
          [projection.propertyId],
        );
        const catalogPolicyProjectionRevision = positiveRevision(owner.rows[0]?.revision);
        if (catalogPolicyProjectionRevision === null) return await malformed(client);
        await client.query("COMMIT");
        return Object.freeze({ outcome: "applied" as const, catalogPolicyProjectionRevision });
      } catch {
        await rollback(client);
        return Object.freeze({ outcome: "unavailable" as const, errorSource: "system" as const });
      } finally {
        client.release();
      }
    },
  });
}

function positiveRevision(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)))
    return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision <= 2_147_483_647 ? revision : null;
}

function profileRevision(value: string): number | null {
  const match = /^profile:([1-9][0-9]*)$/.exec(value);
  return match ? positiveRevision(match[1]) : null;
}

async function malformed(client: CatalogProjectionClient) {
  await client.query("ROLLBACK");
  return Object.freeze({ outcome: "malformed" as const });
}

async function rollback(client: Pick<CatalogProjectionClient, "query">): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined);
}
