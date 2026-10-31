import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createPgHotelSetupTrackCommandRepository,
  lockHotelSetupOrganization,
  parseStoredHotelSetupTrackCommandResult,
  type HotelSetupTrackCommand,
  type HotelSetupTrackCommandRepository,
} from "./domains/hotelSetupTrackCommandRepository.js";
import { createPgSharedHotelSetupStatusRepository } from "./platform/sharedHotelSetupStatusReadModel.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const occurredAt = "2026-07-26T16:00:00.000Z";
const safetyCases = JSON.parse(
  readFileSync(
    new URL("../../../engineering/fixtures/onboarding-command-safety/cases.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: Array<{ id: string; idempotencyKey: string }>;
};

describe("stored hotel setup track command results", () => {
  it("serializes setup writes without locking the identity organization row", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const organizationId = "11111111-1111-4111-8111-111111111111";
    const client = {
      async query(text: string, values?: readonly unknown[]) {
        queries.push({ text, values });
        return text.includes("FROM identity.organizations")
          ? { rows: [{ id: organizationId }], rowCount: 1 }
          : { rows: [], rowCount: 1 };
      },
    };

    await lockHotelSetupOrganization(client, organizationId);

    expect(queries[0]).toEqual({
      text: "SELECT pg_advisory_xact_lock(hashtextextended('hotel-setup-tracks:' || $1::uuid::text, 0))",
      values: [organizationId],
    });
    expect(queries[1]?.text).not.toContain("FOR UPDATE");
  });

  it("accepts complete success and conflict results", () => {
    expect(
      parseStoredHotelSetupTrackCommandResult({
        ok: true,
        response: {
          trackRevision: 1,
          selectedTracks: ["hotel_operations"],
          tracks: [
            {
              track: "hotel_operations",
              provisioning: "active",
              components: [
                { product: "pms", access: "active" },
                { product: "booking", access: "active" },
              ],
              allowedActions: ["manage_service"],
            },
          ],
        },
      }),
    ).not.toBeNull();
    expect(
      parseStoredHotelSetupTrackCommandResult({
        ok: false,
        error: { code: "track_revision_conflict", currentRevision: 1 },
      }),
    ).not.toBeNull();
  });

  it("reads a receipt stored before the retired Creator Marketplace track left the response", () => {
    expect(parseStoredHotelSetupTrackCommandResult(legacyReceipt(retiredTrackStatus()))).toEqual({
      ok: true,
      response: operationsResponse(),
    });
    for (const retired of [
      { ...retiredTrackStatus(), provisioning: "active" },
      { ...retiredTrackStatus(), allowedActions: ["manage_service"] },
      { ...retiredTrackStatus(), components: [{ product: "pms", access: "absent" }] },
      { ...retiredTrackStatus(), extra: true },
    ]) {
      expect(parseStoredHotelSetupTrackCommandResult(legacyReceipt(retired))).toBeNull();
    }
  });

  it.each([
    {},
    { ok: true, response: {} },
    { ok: true, response: { trackRevision: 1, selectedTracks: [], tracks: [] } },
    {
      ok: true,
      response: {
        trackRevision: 2_147_483_648,
        selectedTracks: ["hotel_operations"],
        tracks: [],
      },
    },
    { ok: false },
    { ok: false, error: {} },
    { ok: false, error: { code: "unknown_error" } },
    { ok: false, error: { code: "track_revision_conflict" } },
    { ok: false, error: { code: "idempotency_key_conflict", currentRevision: 1 } },
  ])("rejects malformed persisted result metadata: %j", (stored) => {
    expect(parseStoredHotelSetupTrackCommandResult(stored)).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("hotel setup track command repository", () => {
  const organizationIds: string[] = [];
  const propertyIds: string[] = [];
  const userIds: string[] = [];
  let client: pg.Client;
  let repository: HotelSetupTrackCommandRepository;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    repository = createPgHotelSetupTrackCommandRepository({
      connectionString: TEST_DATABASE_URL!,
      now: () => new Date(occurredAt),
    });
  });

  afterEach(async () => {
    if (organizationIds.length === 0) return;
    await client.query("BEGIN");
    try {
      // Replica mode lets the cleanup delete append-only rows, but it also skips the foreign-key
      // cascades, so the rows that triggers and the property create added are deleted here too
      // (VAY-2427).
      await client.query("SET LOCAL session_replication_role = replica");
      for (const table of [
        "identity.organization_memberships",
        "identity.organization_roles",
        "platform.product_audit_events",
        "platform.idempotency_keys",
        "finance.billing_entitlements",
        "identity.organization_resource_links",
        "identity.product_entitlements",
        "hotel_catalog.organization_setup_track_intents",
      ]) {
        await client.query(`DELETE FROM ${table} WHERE organization_id = ANY($1::uuid[])`, [
          organizationIds,
        ]);
      }
      for (const table of [
        "booking.booking_settings",
        "hotel_catalog.property_slugs",
        "hotel_catalog.property_locations",
        "hotel_catalog.property_contact_channels",
        "hotel_catalog.property_public_profile_read_model",
        "hotel_catalog.property_owner_revisions",
        "platform.finance_export_worker_properties",
      ]) {
        await client.query(`DELETE FROM ${table} WHERE property_id = ANY($1::uuid[])`, [
          propertyIds,
        ]);
      }
      await client.query(`DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])`, [
        propertyIds,
      ]);
      await client.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [userIds]);
      await client.query(`DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])`, [
        organizationIds,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      organizationIds.length = 0;
      propertyIds.length = 0;
      userIds.length = 0;
    }
  });

  afterAll(async () => {
    await repository.close();
    await client.end();
  });

  it("creates, replays, extends, reconciles, and protects a setup intent", async () => {
    const fixture = await createFixture();
    const exactRetry = safetyCase("exact_retry");
    const operations = command(fixture, {
      selectedTracks: ["hotel_operations"],
      expectedRevision: 0,
      idempotencyKey: exactRetry.idempotencyKey,
    });

    expect(
      await repository.getTrackStatus({ organizationId: fixture.organizationId }),
    ).toMatchObject({
      trackRevision: 0,
      selectedTracks: [],
      tracks: [{ track: "hotel_operations", provisioning: "not_selected" }],
    });

    const created = await repository.updateTracks(operations);
    expect(created).toMatchObject({
      ok: true,
      response: {
        trackRevision: 1,
        selectedTracks: ["hotel_operations"],
        tracks: [
          {
            track: "hotel_operations",
            provisioning: "active",
            components: [
              { product: "pms", access: "active" },
              { product: "booking", access: "active" },
            ],
          },
        ],
      },
    });
    expect(await activeEntitlementProducts(fixture.organizationId)).toEqual(["booking", "pms"]);
    expect(await linkedProducts(fixture.organizationId)).toEqual(["booking", "pms"]);
    expect(await count("booking.booking_settings", "property_id", fixture.propertyId)).toBe(1);
    expect(
      await count("platform.product_audit_events", "organization_id", fixture.organizationId),
    ).toBe(1);
    expect(await repository.getTrackStatus({ organizationId: fixture.organizationId })).toEqual(
      created.ok ? created.response : null,
    );
    const statusRepository = createPgSharedHotelSetupStatusRepository({
      connectionString: TEST_DATABASE_URL!,
    });
    try {
      const status = await statusRepository.getHotelSetupStatus({
        organizationId: fixture.organizationId,
        propertyIds: [fixture.propertyId],
      });
      expect(status.properties).toMatchObject([
        {
          propertyId: fixture.propertyId,
          taskFacts: {
            shared_identity: {
              readiness: "actionable",
              reasonCodes: expect.arrayContaining([
                "missing_property_type",
                "missing_street_address",
                "missing_email_contact",
              ]),
            },
          },
        },
      ]);
    } finally {
      await statusRepository.close?.();
    }

    const replay = await repository.updateTracks({
      ...operations,
      audit: {
        requestId: "request-exact-retry",
        correlationId: "correlation-exact-retry",
        source: "admin",
        sourceIp: "192.0.2.20",
        userAgent: "command-safety-fixture",
        receivedAt: "2026-07-26T16:05:00.000Z",
      },
    });
    expect(replay).toEqual(created);
    const stored = await client.query<{ result: unknown }>(
      `SELECT idempotency_metadata -> 'result' AS result
       FROM platform.idempotency_keys
       WHERE operation_scope = 'hotel_catalog'
         AND operation = 'hotel_setup.tracks.update'
         AND organization_id = $1::uuid`,
      [fixture.organizationId],
    );
    expect(stored.rows[0]?.result).toEqual(created);
    expect(
      await count("platform.product_audit_events", "organization_id", fixture.organizationId),
    ).toBe(1);

    const reusedKey = await repository.updateTracks({
      ...operations,
      // The retired Creator Marketplace track (VAY-2270) is not a SetupTrack any more.
      selectedTracks: ["hotel_operations", "creator_marketplace"] as never,
    });
    expect(reusedKey).toMatchObject({
      ok: false,
      error: { code: "idempotency_key_conflict" },
    });
    const reusedKeyWithChangedRevision = await repository.updateTracks({
      ...operations,
      expectedRevision: 1,
    });
    expect(reusedKeyWithChangedRevision).toMatchObject({
      ok: false,
      error: { code: "idempotency_key_conflict" },
    });

    const stale = await repository.updateTracks(
      command(fixture, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
        idempotencyKey: "setup-stale",
      }),
    );
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "track_revision_conflict", currentRevision: 1 },
    });

    // The Creator Marketplace track is retired (VAY-2270): it cannot be added any more.
    const retired = await repository.updateTracks(
      command(fixture, {
        // The retired Creator Marketplace track (VAY-2270) is not a SetupTrack any more.
        selectedTracks: ["hotel_operations", "creator_marketplace"] as never,
        expectedRevision: 1,
        idempotencyKey: "setup-both",
      }),
    );
    expect(retired).toEqual({
      ok: false,
      error: { code: "invalid_setup_request", currentRevision: 1 },
    });
    expect(await activeEntitlementProducts(fixture.organizationId)).toEqual(["booking", "pms"]);

    await client.query(
      `DELETE FROM identity.organization_resource_links
       WHERE organization_id = $1::uuid AND product = 'booking'`,
      [fixture.organizationId],
    );
    const reconciled = await repository.updateTracks(
      command(fixture, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 1,
        idempotencyKey: "setup-reconcile",
      }),
    );
    expect(reconciled).toMatchObject({
      ok: true,
      response: { trackRevision: 1 },
    });
    expect(await linkedProducts(fixture.organizationId)).toEqual(["booking", "pms"]);
  });

  it.each([
    {
      id: "null-metadata",
      mutation: `idempotency_metadata = 'null'::jsonb`,
    },
    {
      id: "status-mismatch",
      mutation: `response_status_code = 409`,
    },
    {
      id: "hash-mismatch",
      mutation: `response_body_hash = repeat('0', 64)`,
    },
  ])("rejects a stored replay with $id", async ({ id, mutation }) => {
    const fixture = await createFixture();
    const request = command(fixture, {
      selectedTracks: ["hotel_operations"],
      expectedRevision: 0,
      idempotencyKey: `setup-malformed-replay-${id}`,
    });
    await expect(repository.updateTracks(request)).resolves.toMatchObject({ ok: true });
    await client.query(
      `UPDATE platform.idempotency_keys
       SET ${mutation}
       WHERE operation_scope = 'hotel_catalog'
         AND operation = 'hotel_setup.tracks.update'
         AND organization_id = $1::uuid`,
      [fixture.organizationId],
    );

    await expect(repository.updateTracks(request)).resolves.toMatchObject({
      ok: false,
      error: { code: "idempotency_key_conflict" },
    });
  });

  it("replays a receipt stored while responses still listed the retired track", async () => {
    const fixture = await createFixture();
    const request = command(fixture, {
      selectedTracks: ["hotel_operations"],
      expectedRevision: 0,
      idempotencyKey: "setup-legacy-receipt",
    });
    const created = await repository.updateTracks(request);
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error("Expected the track update to succeed");
    // The receipt as the server before VAY-2270 step 2 stored it.
    const legacyResponse = {
      ...created.response,
      tracks: [...created.response.tracks, retiredTrackStatus()],
    };
    await client.query(
      `UPDATE platform.idempotency_keys
       SET idempotency_metadata = jsonb_set(idempotency_metadata, '{result,response}', $2::jsonb),
           response_body_hash = $3
       WHERE operation_scope = 'hotel_catalog'
         AND operation = 'hotel_setup.tracks.update'
         AND organization_id = $1::uuid`,
      [
        fixture.organizationId,
        JSON.stringify(legacyResponse),
        createHash("sha256").update(canonicalJson(legacyResponse)).digest("hex"),
      ],
    );

    await expect(repository.updateTracks(request)).resolves.toEqual(created);
  });

  it("records blocked intent without creating either half of Operations", async () => {
    const suspended = await createFixture();
    await client.query(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status, starts_at, metadata
       )
       VALUES (
         $1::uuid, 'booking', 'booking-engine', 'suspended',
         $2::timestamptz, '{"source":"adaptive_hotel_setup"}'::jsonb
       )`,
      [suspended.organizationId, occurredAt],
    );

    const suspendedResult = await repository.updateTracks(
      command(suspended, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
        idempotencyKey: "setup-suspended",
      }),
    );
    expect(suspendedResult).toMatchObject({
      ok: true,
      response: {
        trackRevision: 1,
        selectedTracks: ["hotel_operations"],
      },
    });
    expect(
      suspendedResult.ok
        ? suspendedResult.response.tracks.find((track) => track.track === "hotel_operations")
        : null,
    ).toMatchObject({
      provisioning: "blocked",
      components: [
        { product: "pms", access: "absent" },
        { product: "booking", access: "suspended" },
      ],
    });
    expect(await activeEntitlementProducts(suspended.organizationId)).toEqual([]);
    expect(await linkedProducts(suspended.organizationId)).toEqual([]);

    await client.query(
      `UPDATE identity.product_entitlements
       SET starts_at = NULL, expires_at = $2::timestamptz - interval '1 second'
       WHERE organization_id = $1::uuid AND product = 'booking'`,
      [suspended.organizationId, occurredAt],
    );
    const retried = await repository.updateTracks(
      command(suspended, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 1,
        idempotencyKey: "setup-suspension-expired",
      }),
    );
    expect(retried).toMatchObject({
      ok: true,
      response: {
        trackRevision: 1,
        tracks: [{ track: "hotel_operations", provisioning: "active" }],
      },
    });
    expect(await activeEntitlementProducts(suspended.organizationId)).toEqual(["booking", "pms"]);
    expect(await linkedProducts(suspended.organizationId)).toEqual(["booking", "pms"]);

    const scheduledOwnSuspension = await createFixture();
    await client.query(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status, starts_at, metadata
       )
       VALUES (
         $1::uuid, 'booking', 'booking-engine', 'suspended',
         $2::timestamptz + interval '1 day', '{"source":"adaptive_hotel_setup"}'::jsonb
       )`,
      [scheduledOwnSuspension.organizationId, occurredAt],
    );
    const scheduledOwnSuspensionResult = await repository.updateTracks(
      command(scheduledOwnSuspension, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
        idempotencyKey: "setup-scheduled-own-suspension",
      }),
    );
    expect(scheduledOwnSuspensionResult).toMatchObject({
      ok: true,
      response: {
        tracks: [{ track: "hotel_operations", provisioning: "active" }],
      },
    });

    const billing = await createFixture();
    await client.query(
      `INSERT INTO finance.billing_entitlements (
         organization_id, product, entitlement_key, billing_status, billing_provider
       )
       VALUES ($1::uuid, 'pms', 'property-management', 'active', 'manual')`,
      [billing.organizationId],
    );
    const billingResult = await repository.updateTracks(
      command(billing, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
        idempotencyKey: "setup-billing",
      }),
    );
    expect(billingResult.ok).toBe(true);
    expect(
      billingResult.ok
        ? billingResult.response.tracks.find((track) => track.track === "hotel_operations")
        : null,
    ).toMatchObject({
      provisioning: "blocked",
      components: [
        { product: "pms", access: "unavailable" },
        { product: "booking", access: "absent" },
      ],
    });
    expect(await activeEntitlementProducts(billing.organizationId)).toEqual([]);
    expect(await linkedProducts(billing.organizationId)).toEqual([]);

    const activeBilling = await createFixture();
    const entitlement = await client.query<{ id: string }>(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status, starts_at, metadata
       )
       VALUES (
         $1::uuid, 'pms', 'property-management', 'active', $2::timestamptz,
         '{"source":"finance"}'::jsonb
       )
       RETURNING id`,
      [activeBilling.organizationId, occurredAt],
    );
    await client.query(
      `INSERT INTO finance.billing_entitlements (
         organization_id, identity_entitlement_id, product, entitlement_key,
         billing_status, billing_provider
       )
       VALUES ($1::uuid, $2::uuid, 'pms', 'property-management', 'active', 'manual')`,
      [activeBilling.organizationId, entitlement.rows[0]!.id],
    );
    const activeBillingResult = await repository.updateTracks(
      command(activeBilling, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
        idempotencyKey: "setup-active-billing",
      }),
    );
    expect(activeBillingResult).toMatchObject({
      ok: true,
      response: {
        tracks: [{ track: "hotel_operations", provisioning: "active" }],
      },
    });
    const pmsEntitlements = await client.query<{ entitlementKey: string; source: string }>(
      `SELECT entitlement_key AS "entitlementKey", metadata ->> 'source' AS source
       FROM identity.product_entitlements
       WHERE organization_id = $1::uuid AND product = 'pms'`,
      [activeBilling.organizationId],
    );
    expect(pmsEntitlements.rows).toEqual([
      { entitlementKey: "property-management", source: "finance" },
    ]);

    const suspendedBilling = await createFixture();
    const suspendedIdentity = await client.query<{ id: string }>(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status, starts_at, metadata
       )
       VALUES (
         $1::uuid, 'pms', 'property-management', 'active', $2::timestamptz,
         '{"source":"finance"}'::jsonb
       )
       RETURNING id`,
      [suspendedBilling.organizationId, occurredAt],
    );
    await client.query(
      `INSERT INTO finance.billing_entitlements (
         organization_id, identity_entitlement_id, product, entitlement_key,
         billing_status, billing_provider
       )
       VALUES ($1::uuid, $2::uuid, 'pms', 'property-management', 'suspended', 'manual')`,
      [suspendedBilling.organizationId, suspendedIdentity.rows[0]!.id],
    );
    const suspendedBillingResult = await repository.updateTracks(
      command(suspendedBilling, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
        idempotencyKey: "setup-suspended-billing",
      }),
    );
    expect(
      suspendedBillingResult.ok
        ? suspendedBillingResult.response.tracks.find((track) => track.track === "hotel_operations")
        : null,
    ).toMatchObject({
      provisioning: "blocked",
      components: [
        { product: "pms", access: "suspended" },
        { product: "booking", access: "absent" },
      ],
    });
    expect(await linkedProducts(suspendedBilling.organizationId)).toEqual([]);
    const blockedPropertyRepository = createPgSharedHotelSetupStatusRepository({
      connectionString: TEST_DATABASE_URL!,
    });
    try {
      const blockedProperty = await blockedPropertyRepository.createPropertyProfile({
        organizationId: suspendedBilling.organizationId,
        idempotencyKey: "blocked-operations-property",
        correlationId: "blocked-operations-property",
        profile: completePropertyProfile("Blocked Operations Test Hotel"),
      });
      propertyIds.push(blockedProperty.propertyId);
      expect(blockedProperty).toMatchObject({
        profile: {
          contacts: expect.arrayContaining([
            expect.objectContaining({
              channelType: "email",
              value: "hotel@example.test",
            }),
            expect.objectContaining({
              channelType: "phone",
              value: "+49 30 123456",
            }),
          ]),
          location: {
            localityPublic: false,
            geoPublic: false,
            mapDisplayMode: "hidden",
          },
        },
      });
      expect(
        await linkedProductsForProperty(
          suspendedBilling.organizationId,
          blockedProperty.propertyId,
        ),
      ).toEqual([]);
      expect(
        await count("booking.booking_settings", "property_id", blockedProperty.propertyId),
      ).toBe(0);
      await expect(
        blockedPropertyRepository.createPropertyProfile({
          organizationId: suspendedBilling.organizationId,
          idempotencyKey: "blocked-operations-property",
          correlationId: "blocked-operations-property-replay",
          profile: completePropertyProfile("Blocked Operations Test Hotel"),
        }),
      ).resolves.toMatchObject({ propertyId: blockedProperty.propertyId });
      await expect(
        blockedPropertyRepository.createPropertyProfile({
          organizationId: suspendedBilling.organizationId,
          idempotencyKey: "blocked-operations-property",
          correlationId: "blocked-operations-property-conflict",
          profile: completePropertyProfile("Different Hotel"),
        }),
      ).rejects.toMatchObject({ code: "idempotency_key_conflict" });
    } finally {
      await blockedPropertyRepository.close?.();
    }

    const futureBilling = await createFixture();
    const futureBillingIdentity = await client.query<{ id: string }>(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status, starts_at, metadata
       )
       VALUES (
         $1::uuid, 'pms', 'property-management', 'active', $2::timestamptz,
         '{"source":"finance"}'::jsonb
       )
       RETURNING id`,
      [futureBilling.organizationId, occurredAt],
    );
    await client.query(
      `INSERT INTO finance.billing_entitlements (
         organization_id, identity_entitlement_id, product, entitlement_key,
         billing_status, billing_provider, starts_at
       )
       VALUES (
         $1::uuid, $2::uuid, 'pms', 'property-management', 'suspended', 'manual',
         $3::timestamptz + interval '1 day'
       )`,
      [futureBilling.organizationId, futureBillingIdentity.rows[0]!.id, occurredAt],
    );
    const futureBillingResult = await repository.updateTracks(
      command(futureBilling, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
        idempotencyKey: "setup-future-billing-suspension",
      }),
    );
    expect(
      futureBillingResult.ok
        ? futureBillingResult.response.tracks.find((track) => track.track === "hotel_operations")
        : null,
    ).toMatchObject({
      provisioning: "active",
      components: [
        { product: "pms", access: "active" },
        { product: "booking", access: "active" },
      ],
    });

    const resourceScoped = await createFixture();
    const secondPropertyId = await addProperty(resourceScoped.organizationId);
    await client.query(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status,
         resource_product, resource_type, resource_id, starts_at, metadata
       )
       VALUES (
         $1::uuid, 'pms', 'property-management', 'active',
         'pms', 'pms_property', $2, $3::timestamptz,
         '{"source":"finance"}'::jsonb
      )`,
      [resourceScoped.organizationId, resourceScoped.propertyId, occurredAt],
    );
    await client.query(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status,
         resource_product, resource_type, resource_id, starts_at, metadata
       )
       VALUES (
         $1::uuid, 'pms', 'property-management', 'suspended',
         'pms', 'pms_property', $2, $3::timestamptz,
         '{"source":"finance"}'::jsonb
       )`,
      [resourceScoped.organizationId, secondPropertyId, occurredAt],
    );
    await client.query(
      `INSERT INTO finance.billing_entitlements (
         organization_id, product, entitlement_key, billing_status, billing_provider
       )
       VALUES ($1::uuid, 'pms', 'housekeeping-addon', 'active', 'manual')`,
      [resourceScoped.organizationId],
    );

    const resourceScopedResult = await repository.updateTracks(
      command(resourceScoped, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
        idempotencyKey: "setup-resource-scoped",
      }),
    );
    expect(
      resourceScopedResult.ok
        ? resourceScopedResult.response.tracks.find((track) => track.track === "hotel_operations")
        : null,
    ).toMatchObject({ provisioning: "active" });
    expect(await accountScopedProducts(resourceScoped.organizationId)).toEqual(["booking", "pms"]);
    expect(await count("booking.booking_settings", "property_id", secondPropertyId)).toBe(1);
  });

  it("serializes first writes and rolls the whole command back on audit failure", async () => {
    const concurrent = await createFixture();
    const concurrentStale = safetyCase("concurrent_stale_write");
    const [left, right] = await Promise.all([
      repository.updateTracks(
        command(concurrent, {
          selectedTracks: ["hotel_operations"],
          expectedRevision: 0,
          idempotencyKey: `${concurrentStale.idempotencyKey}-operations`,
        }),
      ),
      repository.updateTracks(
        command(concurrent, {
          selectedTracks: ["hotel_operations"],
          expectedRevision: 0,
          idempotencyKey: `${concurrentStale.idempotencyKey}-second`,
        }),
      ),
    ]);
    expect([left, right].filter((result) => result.ok)).toHaveLength(1);
    expect([left, right].filter((result) => !result.ok)).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          code: "track_revision_conflict",
          currentRevision: 1,
        }),
      }),
    ]);

    const propertyRace = await createFixture();
    const propertyRepository = createPgSharedHotelSetupStatusRepository({
      connectionString: TEST_DATABASE_URL!,
    });
    let blockerOpen = false;
    let trackPromise: ReturnType<HotelSetupTrackCommandRepository["updateTracks"]> | undefined;
    let propertyPromise: ReturnType<typeof propertyRepository.createPropertyProfile> | undefined;
    try {
      await client.query("BEGIN");
      blockerOpen = true;
      await client.query(`SELECT id FROM hotel_catalog.properties WHERE id = $1::uuid FOR UPDATE`, [
        propertyRace.propertyId,
      ]);
      trackPromise = repository.updateTracks(
        command(propertyRace, {
          selectedTracks: ["hotel_operations"],
          expectedRevision: 0,
          idempotencyKey: "setup-property-create-race",
        }),
      );
      await waitForBlockedQuery("FOR UPDATE OF link, property");

      propertyPromise = propertyRepository.createPropertyProfile({
        organizationId: propertyRace.organizationId,
        idempotencyKey: "setup-property-create-race",
        correlationId: "setup-property-create-race",
        profile: completePropertyProfile("Concurrent Track Test Hotel"),
      });
      await waitForBlockedQuery("pg_advisory_xact_lock");
      await client.query("COMMIT");
      blockerOpen = false;

      const [trackSettled, propertySettled] = await Promise.allSettled([
        trackPromise,
        propertyPromise,
      ]);
      if (propertySettled.status === "fulfilled") {
        propertyIds.push(propertySettled.value.propertyId);
      }
      if (trackSettled.status === "rejected") throw trackSettled.reason;
      if (propertySettled.status === "rejected") throw propertySettled.reason;
      const trackResult = trackSettled.value;
      const createdProperty = propertySettled.value;
      expect(trackResult.ok).toBe(true);
      expect(
        await linkedProductsForProperty(propertyRace.organizationId, createdProperty.propertyId),
      ).toEqual(["booking", "pms"]);
      expect(
        await count("booking.booking_settings", "property_id", createdProperty.propertyId),
      ).toBe(1);
    } finally {
      if (blockerOpen) await client.query("ROLLBACK");
      await Promise.allSettled([trackPromise, propertyPromise].filter(Boolean));
      await propertyRepository.close?.();
    }

    const rollback = await createFixture();
    const auditRollback = safetyCase("injected_audit_rollback");
    await expect(
      repository.updateTracks({
        ...command(rollback, {
          selectedTracks: ["hotel_operations"],
          expectedRevision: 0,
          idempotencyKey: auditRollback.idempotencyKey,
        }),
        actorUserId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await activeEntitlementProducts(rollback.organizationId)).toEqual([]);
    expect(await linkedProducts(rollback.organizationId)).toEqual([]);
    expect(
      await count(
        "hotel_catalog.organization_setup_track_intents",
        "organization_id",
        rollback.organizationId,
      ),
    ).toBe(0);
    expect(
      await count("platform.idempotency_keys", "organization_id", rollback.organizationId),
    ).toBe(0);
  }, 30_000);

  async function createFixture() {
    const organizationId = randomUUID();
    const propertyId = randomUUID();
    const actorUserId = randomUUID();
    organizationIds.push(organizationId);
    propertyIds.push(propertyId);
    userIds.push(actorUserId);
    await client.query(`INSERT INTO identity.users (id, email) VALUES ($1::uuid, $2)`, [
      actorUserId,
      `${actorUserId}@example.test`,
    ]);
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug)
       VALUES ($1::uuid, 'hotel_group', 'Track Test Hotel', $2)`,
      [organizationId, `track-test-${organizationId}`],
    );
    await client.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, 'Track Test Hotel')`,
      [propertyId, `track-test-${propertyId}`],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links (
         organization_id, product, resource_type, resource_id, relationship, status
       )
       VALUES ($1::uuid, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    return { organizationId, propertyId, actorUserId };
  }

  async function addProperty(organizationId: string): Promise<string> {
    const propertyId = randomUUID();
    propertyIds.push(propertyId);
    await client.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, 'Second Track Test Hotel')`,
      [propertyId, `track-test-${propertyId}`],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links (
         organization_id, product, resource_type, resource_id, relationship, status
       )
       VALUES ($1::uuid, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    return propertyId;
  }

  async function createOrganizationForProperty(propertyId: string) {
    const organizationId = randomUUID();
    const actorUserId = randomUUID();
    organizationIds.push(organizationId);
    userIds.push(actorUserId);
    await client.query(`INSERT INTO identity.users (id, email) VALUES ($1::uuid, $2)`, [
      actorUserId,
      `${actorUserId}@example.test`,
    ]);
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug)
       VALUES ($1::uuid, 'hotel_group', 'Track Test Operator', $2)`,
      [organizationId, `track-test-${organizationId}`],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links (
         organization_id, product, resource_type, resource_id, relationship, status
       )
       VALUES ($1::uuid, 'hotel_catalog', 'property', $2, 'operator', 'active')`,
      [organizationId, propertyId],
    );
    return { organizationId, actorUserId };
  }

  function command(
    fixture: { organizationId: string; actorUserId: string },
    input: Pick<HotelSetupTrackCommand, "selectedTracks" | "expectedRevision" | "idempotencyKey">,
  ): HotelSetupTrackCommand {
    return {
      ...input,
      organizationId: fixture.organizationId,
      actorUserId: fixture.actorUserId,
      audit: {
        requestId: `request-${input.idempotencyKey}`,
        correlationId: `correlation-${input.idempotencyKey}`,
        source: "web",
        receivedAt: occurredAt,
      },
    };
  }

  function safetyCase(id: string): { id: string; idempotencyKey: string } {
    const fixture = safetyCases.cases.find((candidate) => candidate.id === id);
    if (!fixture) throw new Error(`Missing onboarding command-safety fixture "${id}"`);
    return fixture;
  }

  async function activeEntitlementProducts(organizationId: string): Promise<string[]> {
    const result = await client.query<{ product: string }>(
      `SELECT product
       FROM identity.product_entitlements
       WHERE organization_id = $1::uuid
         AND status = 'active'
       ORDER BY product`,
      [organizationId],
    );
    return result.rows.map((row) => row.product);
  }

  async function accountScopedProducts(organizationId: string): Promise<string[]> {
    const result = await client.query<{ product: string }>(
      `SELECT product
       FROM identity.product_entitlements
       WHERE organization_id = $1::uuid
         AND status = 'active'
         AND resource_product IS NULL
         AND resource_type IS NULL
         AND resource_id IS NULL
       ORDER BY product`,
      [organizationId],
    );
    return result.rows.map((row) => row.product);
  }

  async function linkedProducts(organizationId: string): Promise<string[]> {
    const result = await client.query<{ product: string }>(
      `SELECT product
       FROM identity.organization_resource_links
       WHERE organization_id = $1::uuid
         AND product IN ('booking', 'pms', 'marketplace')
         AND status = 'active'
       ORDER BY product`,
      [organizationId],
    );
    return result.rows.map((row) => row.product);
  }

  async function linkedProductsForProperty(
    organizationId: string,
    propertyId: string,
  ): Promise<string[]> {
    const result = await client.query<{ product: string }>(
      `SELECT product
       FROM identity.organization_resource_links
       WHERE organization_id = $1::uuid
         AND resource_id = $2
         AND product IN ('booking', 'pms', 'marketplace')
         AND status = 'active'
       ORDER BY product`,
      [organizationId, propertyId],
    );
    return result.rows.map((row) => row.product);
  }

  async function count(table: string, column: string, id: string): Promise<number> {
    const result = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table} WHERE ${column} = $1::uuid`,
      [id],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function waitForBlockedQuery(fragment: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await client.query("SELECT pg_stat_clear_snapshot()");
      const result = await client.query(
        `SELECT 1
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query LIKE '%' || $1 || '%'
         LIMIT 1`,
        [fragment],
      );
      if (result.rows.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await client.query("SELECT pg_stat_clear_snapshot()");
    const activity = await client.query<{
      state: string;
      waitEventType: string | null;
      waitEvent: string | null;
      query: string;
    }>(
      `SELECT
         state,
         wait_event_type AS "waitEventType",
         wait_event AS "waitEvent",
         query
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND state <> 'idle'
       ORDER BY pid`,
    );
    throw new Error(
      `Timed out waiting for blocked query containing "${fragment}": ${JSON.stringify(activity.rows)}`,
    );
  }
});

function completePropertyProfile(displayName: string) {
  return {
    displayName,
    propertyType: "hotel",
    location: {
      countryCode: "DE",
      city: "Berlin",
      streetAddress: "1 Test Street",
      postalCode: "10115",
      timezone: "Europe/Berlin",
      latitude: null,
      longitude: null,
      localityPublic: false,
      geoPublic: false,
      mapDisplayMode: "hidden" as const,
    },
    contacts: [
      {
        channelType: "email" as const,
        value: "hotel@example.test",
        purpose: "guest" as const,
        isPublic: false,
      },
      {
        channelType: "phone" as const,
        value: "+49 30 123456",
        purpose: "operations" as const,
        isPublic: false,
      },
    ],
  };
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}

function operationsResponse() {
  return {
    trackRevision: 1,
    selectedTracks: ["hotel_operations"],
    tracks: [
      {
        track: "hotel_operations",
        provisioning: "active",
        components: [
          { product: "pms", access: "active" },
          { product: "booking", access: "active" },
        ],
        allowedActions: ["manage_service"],
      },
    ],
  };
}

function retiredTrackStatus(): Record<string, unknown> {
  return {
    track: "creator_marketplace",
    provisioning: "not_selected",
    components: [{ product: "marketplace", access: "absent" }],
    allowedActions: ["add"],
  };
}

function legacyReceipt(retired: Record<string, unknown>) {
  const response = operationsResponse();
  return { ok: true, response: { ...response, tracks: [...response.tracks, retired] } };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
