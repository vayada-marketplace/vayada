import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgBookingSetupLifecycleStatusRepository } from "./domains/bookingSetupLifecycleStatusRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const organizationId = "14900000-0000-4000-8000-000000000001";
const propertyId = "14900000-0000-4000-8000-000000000002";
const actorUserId = "14900000-0000-4000-8000-000000000003";
const bookingRevisionId = "14900000-0000-4000-8000-000000000005";

describe.skipIf(!TEST_DATABASE_URL)("Review lifecycle PostgreSQL adapters", () => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const booking = createPgBookingSetupLifecycleStatusRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    pool: client,
  });
  const scope = { organizationId, propertyId, actorUserId };

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await client.connect();
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'vay-1049-review@example.test', 'VAY-1049 Review', 'active')`,
      [actorUserId],
    );
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1049 Lifecycle Test', 'vay-1049-lifecycle-test', 'active')`,
      [organizationId],
    );
    await client.query(
      `INSERT INTO identity.organization_memberships (
         organization_id, user_id, status, role_key, access_origin
       ) VALUES ($1::uuid, $2::uuid, 'active', 'hotel_owner', 'agency')`,
      [organizationId, actorUserId],
    );
    await client.query(
      `INSERT INTO hotel_catalog.properties (
         id, public_id, display_name, profile_status
       ) VALUES ($1::uuid, 'prop_vay_1049_lifecycle_test', 'VAY-1049 Lifecycle Hotel', 'complete')`,
      [propertyId],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links (
         organization_id, product, resource_type, resource_id, relationship, status
       ) VALUES
         ($1::uuid, 'booking', 'booking_hotel', $2::text, 'owner', 'active'),
         ($1::uuid, 'booking', 'booking_hotel', $2::text, 'operator', 'active')`,
      [organizationId, propertyId],
    );
    await client.query(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status,
         resource_product, resource_type, resource_id
       ) VALUES
         ($1::uuid, 'booking', 'booking-engine', 'active',
          'booking', 'booking_hotel', $2::text)`,
      [organizationId, propertyId],
    );
  });

  afterAll(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });

  it("reads authorized not-started lifecycle state without setup or readiness proxies", async () => {
    await expect(booking.getBookingSetupLifecycleStatus(scope)).resolves.toMatchObject({
      ...scope,
      product: "booking",
      phase: "not_started",
    });
  });

  it("reads Booking publication only from the active Distribution pointer", async () => {
    await client.query(
      `INSERT INTO distribution.public_booking_content_revisions (
         id, property_id, revision_number, readiness_contract_version,
         source_manifest, source_manifest_hash, readiness_hash,
         readiness_product, readiness_status, public_content, built_by_user_id
       ) VALUES (
         $1::uuid, $2::uuid, 1, 'onboarding-product-readiness.v1',
         $3::jsonb, $4, $4, 'booking', 'ready', '{}'::jsonb, $5::uuid
       )`,
      [bookingRevisionId, propertyId, sourceManifest(), `sha256:${"2".repeat(64)}`, actorUserId],
    );
    await client.query(
      `INSERT INTO distribution.active_public_booking_revision (
         property_id, content_revision_id, activated_by_user_id
       ) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [propertyId, bookingRevisionId, actorUserId],
    );
    await expect(booking.getBookingSetupLifecycleStatus(scope)).resolves.toMatchObject({
      phase: "published",
      sourceRevision: expect.stringMatching(/^booking-review:sha256:[0-9a-f]{64}$/),
    });
  });

  it("rejects an actor without the authorized membership boundary", async () => {
    const unauthorized = { ...scope, actorUserId: "14900000-0000-4000-8000-000000000099" };
    await expect(booking.getBookingSetupLifecycleStatus(unauthorized)).rejects.toThrow(
      "scope is unavailable",
    );
  });

  it("rejects inactive resource relationships", async () => {
    await client.query(
      `UPDATE identity.organization_resource_links
       SET status = 'suspended'
       WHERE organization_id = $1::uuid
         AND product = 'booking'
         AND resource_type = 'booking_hotel'
         AND resource_id = $2::text`,
      [organizationId, propertyId],
    );
    await expect(booking.getBookingSetupLifecycleStatus(scope)).rejects.toThrow(
      "scope is unavailable",
    );
  });
});

function sourceManifest(): string {
  return JSON.stringify({
    contractVersion: "onboarding-source-manifest.v1",
    propertyId,
    sources: [
      {
        ownerDomain: "hotel_catalog",
        entityType: "property_profile",
        entityId: propertyId,
        revision: "profile-r1",
      },
    ],
  });
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
