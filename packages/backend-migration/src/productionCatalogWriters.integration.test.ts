import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { writeProductionCatalogContent } from "./productionCatalogContentWriter.js";
import { writeProductionCatalogCore } from "./productionCatalogCoreWriter.js";
import { buildProductionCatalogPlan } from "./productionCatalogPlan.js";
import { writeProductionCatalogPresentation } from "./productionCatalogPresentationWriter.js";
import { rebuildProductionCatalogPublicProjection } from "./productionCatalogPublicProjection.js";
import type { ReconciledCatalogWrites } from "./productionCatalogReconciliation.js";
import {
  readProductionCatalogTargetState,
  type ProductionCatalogTargetState,
} from "./productionCatalogTargetReader.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "13540000-0000-4000-8000-000000000001";
const SLUG = "13540000-0000-4000-8000-000000000002";
const DOMAIN = "13540000-0000-4000-8000-000000000003";
const MEDIA_OBJECT = "13540000-0000-4000-8000-000000000004";
const MEDIA_ASSIGNMENT = "13540000-0000-4000-8000-000000000005";
const USER = "13540000-0000-4000-8000-000000000006";
const ORGANIZATION = "13540000-0000-4000-8000-000000000007";
const UPDATED = "2026-08-02T00:00:00Z";
const RUN = "vay1351-0123456789abcdef01234567";
const OUTSIDE = "13540000-0000-4000-8000-000000000008";
const OUTSIDE_MEDIA = "13540000-0000-4000-8000-000000000009";

describe.skipIf(!URL)("production catalog writers (PostgreSQL)", () => {
  let client: pg.Client;
  beforeAll(async () => {
    assertSafeTestDatabase(URL!);
    client = new pg.Client({ connectionString: URL });
    await client.connect();
  });
  afterAll(async () => client.end());

  it("writes the real target schema without exposing legacy-private fields", async () => {
    await client.query("BEGIN");
    try {
      const writes = fixtureWrites();
      expect(
        await writeProductionCatalogCore(
          client,
          writes,
          [
            {
              propertyId: PROPERTY,
              sourceSystem: "booking",
              sourceTable: "booking_hotels",
              sourceId: PROPERTY,
              relationship: "canonical_input",
              migrationDisposition: "canonical",
              migrationDispositionReason: null,
            },
          ],
          "vay1351-0123456789abcdef01234567",
        ),
      ).toMatchObject({
        properties: 1,
        sourceLinks: 1,
        slugs: 1,
        locations: 1,
      });
      expect(await writeProductionCatalogContent(client, writes)).toMatchObject({
        profiles: 1,
        amenities: 1,
        contacts: 1,
        policies: 1,
      });
      await client.query(
        `INSERT INTO platform.media_objects
           (id, bucket, storage_key, visibility, purpose, property_id, resource_product,
            resource_type, lifecycle_status, source_system, source_table, source_row_id,
            public_approved)
         VALUES ($1, 'test', 'safe/original.jpg', 'public', 'property.hero_image', $2,
                 'hotel_catalog', 'property', 'active', 'booking', 'booking_hotels',
                 $3, TRUE)`,
        [MEDIA_OBJECT, PROPERTY, `${PROPERTY}:hero_image`],
      );
      await client.query(
        `INSERT INTO platform.media_variants
           (media_object_id, variant_name, visibility, storage_key, content_type, public_cdn_url)
         VALUES ($1, 'original_safe', 'public', 'safe/original.jpg', 'image/jpeg',
                 'https://cdn.example.test/safe.jpg')`,
        [MEDIA_OBJECT],
      );
      expect(await writeProductionCatalogPresentation(client, writes)).toEqual({
        domains: 1,
        media: 1,
      });
      expect(await rebuildProductionCatalogPublicProjection(client, [PROPERTY], "run")).toBe(1);

      const stored = await client.query(
        `SELECT location, media, amenities, public_contacts AS "publicContacts"
         FROM hotel_catalog.property_public_profile_read_model WHERE property_id = $1`,
        [PROPERTY],
      );
      expect(stored.rows[0]).toMatchObject({
        location: { countryCode: "AT", city: "Vienna", timezone: "Europe/Vienna" },
        media: [{ url: "https://cdn.example.test/safe.jpg", platformMediaObjectId: MEDIA_OBJECT }],
        amenities: [],
        publicContacts: [],
      });
      expect(JSON.stringify(stored.rows[0])).not.toContain("PRIVATE RAW LOCATION");
      expect(JSON.stringify(stored.rows[0])).not.toContain("Private street");
      const assignment = await client.query(
        `SELECT url, public_approved AS "publicApproved"
         FROM hotel_catalog.property_media WHERE id = $1`,
        [MEDIA_ASSIGNMENT],
      );
      expect(assignment.rows[0]).toEqual({
        url: `platform-media:${MEDIA_OBJECT}`,
        publicApproved: true,
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("replans stored domain timestamps with a stable checksum and zero writes", async () => {
    await client.query("BEGIN");
    try {
      const first = buildProductionCatalogPlan(catalogRows(), emptyCatalogTarget());
      expect(first.blockers).toEqual([]);
      expect(first.writes.domains).toHaveLength(1);
      expect(first.writes.media).toHaveLength(1);

      await writeProductionCatalogCore(
        client,
        first.writes,
        first.sourceLinks,
        "vay1351-0123456789abcdef01234567",
      );
      await writeProductionCatalogContent(client, first.writes);
      await client.query(
        `INSERT INTO platform.media_objects
           (id, bucket, storage_key, visibility, purpose, property_id, resource_product,
            resource_type, lifecycle_status, source_system, source_table, source_row_id,
            public_approved)
         VALUES ($1, 'test', 'safe/replan.jpg', 'public', 'property.hero_image', $2,
                 'hotel_catalog', 'property', 'active', 'booking', 'booking_hotels',
                 $3, TRUE)`,
        [MEDIA_OBJECT, PROPERTY, `${PROPERTY}:hero_image`],
      );
      await writeProductionCatalogPresentation(client, first.writes);

      const storedDomains = await client.query(
        `SELECT id::text, property_id::text AS "propertyId", hostname,
                verification_status AS "verificationStatus",
                canonical_when_verified AS "canonicalWhenVerified",
                verified_at::text AS "verifiedAt", updated_at::text AS "updatedAt"
         FROM hotel_catalog.property_domains WHERE property_id = $1`,
        [PROPERTY],
      );
      const storedMedia = await client.query(
        `SELECT id::text, property_id::text AS "propertyId", media_type AS "mediaType", url,
                alt_text AS "altText", sort_order AS "sortOrder",
                source_system AS "sourceSystem", public_approved AS "publicApproved",
                platform_media_object_id::text AS "platformMediaObjectId",
                created_at::text AS "createdAt", updated_at::text AS "updatedAt"
         FROM hotel_catalog.property_media WHERE property_id = $1`,
        [PROPERTY],
      );
      const target = emptyCatalogTarget();
      target.properties = first.writes.properties;
      target.slugs = first.writes.slugs;
      target.domains = storedDomains.rows;
      target.locations = first.writes.locations;
      target.profiles = first.writes.profiles;
      target.amenities = first.writes.amenities;
      target.contacts = first.writes.contacts;
      target.policies = first.writes.policies;
      target.media = storedMedia.rows;

      const verified = buildProductionCatalogPlan(catalogRows(), target);
      expect(verified.blockers).toEqual([]);
      expect(verified.checksum).toBe(first.checksum);
      expect(verified.counts.writes).toBe(0);

      await client.query(
        `UPDATE hotel_catalog.property_domains
         SET verification_status = 'verified', canonical_when_verified = TRUE,
             verified_at = '2026-08-03T00:00:00.123456Z',
             updated_at = '2026-08-03T00:00:00.123456Z'
         WHERE property_id = $1`,
        [PROPERTY],
      );
      const storedVerifiedDomains = await client.query(
        `SELECT id::text, property_id::text AS "propertyId", hostname,
                verification_status AS "verificationStatus",
                canonical_when_verified AS "canonicalWhenVerified",
                verified_at::text AS "verifiedAt", updated_at::text AS "updatedAt"
         FROM hotel_catalog.property_domains WHERE property_id = $1`,
        [PROPERTY],
      );
      const postgresTarget = { ...target, domains: storedVerifiedDomains.rows };
      const isoTarget = {
        ...postgresTarget,
        domains: storedVerifiedDomains.rows.map((row) => ({
          ...row,
          verifiedAt: "2026-08-03T00:00:00.123456Z",
          updatedAt: "2026-08-03T00:00:00.123456Z",
        })),
      };
      const postgresVerified = buildProductionCatalogPlan(catalogRows(), postgresTarget);
      const isoVerified = buildProductionCatalogPlan(catalogRows(), isoTarget);

      expect(postgresVerified.blockers).toEqual([]);
      expect(postgresVerified.counts.writes).toBe(0);
      expect(postgresVerified.checksum).toBe(isoVerified.checksum);
      expect(postgresVerified.preservedTarget).toContainEqual(
        expect.objectContaining({ entity: "property_domains", reason: "identical" }),
      );
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("keeps a hotel outside the VAY-1362 cohort private through writers and projection", async () => {
    await client.query("BEGIN");
    try {
      // An owner path the identity step would normally have archived already.
      await client.query(
        `INSERT INTO identity.organizations (id, kind, name, slug, status)
         VALUES ($1::uuid, 'hotel_group', 'Cohort outsider', $1::uuid::text, 'active')`,
        [ORGANIZATION],
      );
      await client.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         SELECT $1, 'booking', 'booking_hotel', id, 'owner', 'active' FROM unnest($2::text[]) id`,
        [ORGANIZATION, [OUTSIDE, PROPERTY]],
      );
      await client.query(
        `INSERT INTO identity.product_entitlements
           (organization_id, product, entitlement_key, status, resource_product, resource_type,
            resource_id)
         VALUES ($1, 'booking', 'booking-engine', 'active', 'booking', 'booking_hotel', $2)`,
        [ORGANIZATION, OUTSIDE],
      );
      const rows = outsideRows();
      const cohort = { bookingHotelIds: [PROPERTY], pmsHotelIds: [], marketplaceHotelIds: [] };
      const target = await readProductionCatalogTargetState(client, [OUTSIDE], RUN);
      target.mediaObjects = [
        {
          id: OUTSIDE_MEDIA,
          propertyId: OUTSIDE,
          purpose: "property.hero_image",
          sourceSystem: "booking",
          sourceTable: "booking_hotels",
          sourceRowId: `${OUTSIDE}:hero_image`,
          visibility: "public",
          lifecycleStatus: "active",
          publicApproved: true,
        },
      ];
      const plan = buildProductionCatalogPlan(rows, target, cohort);
      expect(plan.blockers).toEqual([]);
      expect(plan.writes.domains).toEqual([]);

      await writeProductionCatalogCore(client, plan.writes, plan.sourceLinks, RUN);
      await client.query(
        `INSERT INTO platform.media_objects
           (id, bucket, storage_key, visibility, purpose, property_id, resource_product,
            resource_type, lifecycle_status, source_system, source_table, source_row_id,
            public_approved, source_metadata)
         VALUES ($1, 'test', 'safe/outside.jpg', 'public', 'property.hero_image', $2,
                 'hotel_catalog', 'property', 'active', 'booking', 'booking_hotels',
                 $3, TRUE, jsonb_build_object('migrationRunId', $4::text))`,
        [OUTSIDE_MEDIA, OUTSIDE, `${OUTSIDE}:hero_image`, RUN],
      );
      await client.query(
        `INSERT INTO platform.media_variants
           (media_object_id, variant_name, visibility, storage_key, content_type, public_cdn_url)
         VALUES ($1, 'original_safe', 'public', 'safe/outside.jpg', 'image/jpeg',
                 'https://cdn.example.test/outside.jpg')`,
        [OUTSIDE_MEDIA],
      );
      await writeProductionCatalogContent(client, plan.writes);
      await writeProductionCatalogPresentation(client, plan.writes);
      await rebuildProductionCatalogPublicProjection(client, [OUTSIDE], RUN);

      const access = await client.query(
        `SELECT (SELECT status FROM identity.organization_resource_links
                  WHERE resource_id = $1::uuid::text) AS link,
                (SELECT status FROM identity.product_entitlements
                  WHERE resource_id = $1::uuid::text) AS entitlement,
                (SELECT metadata ->> 'migrationDispositionReason'
                   FROM hotel_catalog.property_source_links
                  WHERE source_id = $1::uuid::text) AS reason,
                (SELECT count(*)::int FROM hotel_catalog.property_domains
                  WHERE property_id = $1::uuid) AS domains,
                (SELECT array_agg(slug ORDER BY slug) FROM hotel_catalog.property_slugs
                  WHERE property_id = $1::uuid) AS slugs,
                (SELECT bool_or(public_approved) FROM hotel_catalog.property_media
                  WHERE property_id = $1::uuid) AS "publicMedia"`,
        [OUTSIDE],
      );
      expect(access.rows[0]).toEqual({
        link: "archived",
        entitlement: "expired",
        reason: "outside_migration_cohort",
        domains: 0,
        slugs: ["cohort-outsider", "cohort-outsider-old"],
        publicMedia: false,
      });
      const projected = await client.query(
        `SELECT public_id AS "publicId", canonical_slug AS "canonicalSlug",
                verified_custom_domain AS "verifiedCustomDomain", profile_status AS "profileStatus",
                media
         FROM hotel_catalog.property_public_profile_read_model WHERE property_id = $1`,
        [OUTSIDE],
      );
      expect(projected.rows[0]).toEqual({
        publicId: `legacy-private-property-${OUTSIDE}`,
        canonicalSlug: "cohort-outsider",
        verifiedCustomDomain: null,
        profileStatus: "private",
        media: [],
      });

      const replanned = buildProductionCatalogPlan(
        rows,
        await readProductionCatalogTargetState(client, plan.propertyIds, RUN),
        cohort,
      );
      expect(replanned.blockers).toEqual([]);
      expect(replanned.checksum).toBe(plan.checksum);
      expect(replanned.counts.writes).toBe(0);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

// The cohort hotel PROPERTY stays in the snapshot (no media or domain): COHORT_HOTEL_UNRESOLVED
// blocks a cohort hotel the plan cannot resolve.
function outsideRows(): IdentitySourceRow[] {
  const [user, hotel] = catalogRows();
  return [
    user!,
    { ...hotel!, data: { ...hotel!.data, hero_image: null, custom_domain: null } },
    {
      ...hotel!,
      data: {
        ...hotel!.data,
        id: OUTSIDE,
        slug: "cohort-outsider",
        custom_domain: "outsider.example.test",
        previous_slugs: ["cohort-outsider-old"],
      },
    },
  ];
}

function catalogRows(): IdentitySourceRow[] {
  return [
    {
      sourceDatabase: "auth",
      sourceTable: "users",
      rowOrdinal: 1,
      data: { id: USER, type: "hotel", status: "verified" },
    },
    {
      sourceDatabase: "booking",
      sourceTable: "booking_hotels",
      rowOrdinal: 1,
      data: {
        id: PROPERTY,
        user_id: USER,
        name: "Hotel",
        slug: "catalog-integration",
        custom_domain: "catalog.example.test",
        platform_status: "live",
        country: "AT",
        timezone: "Europe/Vienna",
        supported_languages: ["en"],
        default_language: "en",
        previous_slugs: [],
        amenities: [],
        images: [],
        hero_image: "https://legacy.example.test/hero.jpg",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: UPDATED,
      },
    },
  ];
}

function emptyCatalogTarget(): ProductionCatalogTargetState {
  return {
    properties: [],
    sourceLinks: [],
    ownerLinks: [
      {
        organizationId: ORGANIZATION,
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: PROPERTY,
        relationship: "owner",
        status: "active",
      },
    ],
    slugs: [],
    domains: [],
    locations: [],
    profiles: [],
    amenities: [],
    contacts: [],
    policies: [],
    media: [],
    mediaObjects: [
      {
        id: MEDIA_OBJECT,
        propertyId: PROPERTY,
        purpose: "property.hero_image",
        sourceSystem: "booking",
        sourceTable: "booking_hotels",
        sourceRowId: `${PROPERTY}:hero_image`,
        visibility: "public",
        lifecycleStatus: "active",
        publicApproved: true,
      },
    ],
    ownerRevisions: [],
  };
}

function fixtureWrites(): ReconciledCatalogWrites {
  return {
    properties: [
      {
        id: PROPERTY,
        publicId: "catalog-integration",
        displayName: "Hotel",
        propertyType: "hotel",
        category: null,
        starRating: 4,
        defaultLocale: "en",
        supportedLocales: ["en"],
        profileStatus: "complete",
        completenessReasons: [],
        createdAt: UPDATED,
        updatedAt: UPDATED,
      },
    ],
    slugs: [
      {
        id: SLUG,
        propertyId: PROPERTY,
        slug: "catalog-integration",
        purpose: "canonical",
        status: "active",
        redirectsToId: null,
        updatedAt: UPDATED,
      },
    ],
    domains: [
      {
        id: DOMAIN,
        propertyId: PROPERTY,
        hostname: "catalog.example.test",
        verificationStatus: "pending",
        canonicalWhenVerified: false,
        verifiedAt: null,
        updatedAt: UPDATED,
      },
    ],
    locations: [
      {
        propertyId: PROPERTY,
        countryCode: "AT",
        region: null,
        city: "Vienna",
        streetAddress: "Private street",
        postalCode: "1010",
        rawMarketplaceLocation: "PRIVATE RAW LOCATION",
        latitude: null,
        longitude: null,
        timezone: "Europe/Vienna",
        sourceConfidence: "high",
        migrationNotes: null,
        updatedAt: UPDATED,
      },
    ],
    profiles: [
      {
        propertyId: PROPERTY,
        locale: "en",
        shortDescription: null,
        longDescription: "Public hotel description",
        sourceConfidence: "high",
        updatedAt: UPDATED,
      },
    ],
    amenities: [
      {
        propertyId: PROPERTY,
        amenityKey: "wifi",
        label: "Wi-Fi",
        sourceSystem: "booking",
        publicSafe: false,
        updatedAt: UPDATED,
      },
    ],
    contacts: [
      {
        propertyId: PROPERTY,
        channelType: "phone",
        value: "+431234",
        purpose: "general",
        isPublic: false,
        sourceSystem: "booking",
        updatedAt: UPDATED,
      },
    ],
    policies: [
      {
        propertyId: PROPERTY,
        checkInTime: "15:00",
        checkOutTime: "11:00",
        cancellationSummary: "Private terms",
        paymentPolicySummary: null,
        updatedAt: UPDATED,
      },
    ],
    media: [
      {
        id: MEDIA_ASSIGNMENT,
        propertyId: PROPERTY,
        platformMediaObjectId: MEDIA_OBJECT,
        mediaType: "hero_image",
        sortOrder: 0,
        sourceSystem: "booking",
        publicApproved: true,
        updatedAt: UPDATED,
      },
    ],
  };
}
