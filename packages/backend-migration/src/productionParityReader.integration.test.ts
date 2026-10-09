import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";

import {
  readProductionParityEvidence,
  withProductionParityTargetWriteFreeze,
  type ProductionParityConfig,
} from "./productionParity.js";
import {
  parseProductionMigrationCohort,
  writeProductionMigrationCohort,
} from "./productionMigrationCohort.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const RUN_ID = `vay1351-${"9".repeat(24)}`;
const STALE_RUN_ID = `vay1351-${"8".repeat(24)}`;
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
const PROPERTY_ID = "13590000-0000-4000-8000-000000000001";
const PROPERTY_MEDIA_ID = "13590000-0000-4000-8000-000000000002";
const MEDIA_OBJECT_ID = "13590000-0000-4000-8000-000000000003";
const ADDON_ID = "13590000-0000-4000-8000-000000000004";
const OTHER_MEDIA_OBJECT_ID = "13590000-0000-4000-8000-000000000005";
const CREATOR_ORGANIZATION_ID = "13590000-0000-4000-8000-000000000006";
const HOTEL_ORGANIZATION_ID = "13590000-0000-4000-8000-000000000007";
const CREATOR_PROFILE_ID = "13590000-0000-4000-8000-000000000008";
const LISTING_ID = "13590000-0000-4000-8000-000000000009";
const COLLABORATION_ID = "13590000-0000-4000-8000-000000000010";
const MESSAGE_ID = "13590000-0000-4000-8000-000000000011";
const ROOM_TYPE_ID = "13590000-0000-4000-8000-000000000012";
const ROOM_MEDIA_OBJECT_ID = "13590000-0000-4000-8000-000000000013";
// VAY-1362 cohort fixture. The cohort table is append-only, so each case owns its source run.
const COHORT_PASS_RUN_ID = `vay1351-${"7".repeat(24)}`;
const COHORT_FAIL_RUN_ID = `vay1351-${"6".repeat(24)}`;
const COHORT_AUTO_OPEN_RUN_ID = `vay1351-${"5".repeat(24)}`;
const IN_HOTEL_ID = "13620000-0000-4000-8000-000000000001";
const OUT_HOTEL_ID = "13620000-0000-4000-8000-000000000002";
const OUT_PMS_HOTEL_ID = "13620000-0000-4000-8000-000000000003";
const MISSING_HOTEL_ID = "13620000-0000-4000-8000-000000000004";
const OUT_ORGANIZATION_ID = "13620000-0000-4000-8000-000000000005";
const OUT_USER_ID = "13620000-0000-4000-8000-000000000006";
const OUT_OFFER_ID = "13620000-0000-4000-8000-000000000007";
const OUT_ROOM_TYPE_ID = "13620000-0000-4000-8000-000000000008";
const OUT_CONNECTION_ID = "13620000-0000-4000-8000-000000000009";
const IN_ORGANIZATION_ID = "13620000-0000-4000-8000-000000000010";
const IN_PMS_HOTEL_ID = "13620000-0000-4000-8000-000000000011";
const COHORT_SUBJECTS = new Set([IN_HOTEL_ID, OUT_HOTEL_ID, OUT_PMS_HOTEL_ID, MISSING_HOTEL_ID]);

describe.skipIf(!URL)("production parity evidence reader (PostgreSQL)", () => {
  beforeEach(async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await cleanup(client);
    } finally {
      await client.end();
    }
  });

  it("reads the migrated extraction, ledger, PII, media, and provenance contracts", async () => {
    assertSafeTestDatabase(URL!);
    const evidence = await readProductionParityEvidence(config());

    expect(evidence.extraction).toBeNull();
    expect(evidence.sources).toEqual([]);
    expect(evidence.migrationLedger.length).toBeGreaterThan(100);
    expect(evidence.missingMigrationVersions).toEqual([]);
    expect(evidence.piiExposureCount).toBe(0);
    expect(evidence.rawLegacyMediaReferenceCount).toBe(0);
    expect(evidence.staleProvenanceCount).toBeGreaterThanOrEqual(0);
  });

  it("detects an orphan raw media URL that is absent from the canonical registry", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-orphan-media', 'Parity orphan media')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO booking.booking_settings (property_id, hero_image_url)
         VALUES ($1, 'https://legacy.example.test/orphan.jpg')`,
        [PROPERTY_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.rawLegacyMediaReferenceCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("detects normalized sensitive keys in nested public JSON", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-sensitive-json', 'Parity sensitive JSON')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO hotel_catalog.property_public_profile_read_model
           (property_id, public_id, display_name, canonical_slug, default_locale,
            supported_locales, profile_status, descriptions)
         VALUES ($1, 'parity-sensitive-json', 'Parity sensitive JSON',
                 'parity-sensitive-json', 'en', ARRAY['en'], 'complete',
                 '{"room_summary":{"guestEmail":"opaque-private-reference"}}'::jsonb)`,
        [PROPERTY_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.piiExposureCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("reuses the canonical public-exposure policy for non-email PII", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-private-ip', 'Parity private IP')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO hotel_catalog.property_public_profile_read_model
           (property_id, public_id, display_name, canonical_slug, default_locale,
            supported_locales, profile_status, descriptions)
         VALUES ($1, 'parity-private-ip', 'Parity private IP', 'parity-private-ip',
                 'en', ARRAY['en'], 'complete',
                 '{"room_summary":{"ipAddress":"203.0.113.1"}}'::jsonb)`,
        [PROPERTY_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.piiExposureCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("detects stale active Catalog source-link provenance", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-stale-catalog-link', 'Parity stale Catalog link')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO hotel_catalog.property_source_links
           (property_id, source_system, source_table, source_id, relationship, metadata)
         VALUES ($1::uuid, 'booking', 'booking_hotels', $1::uuid::text, 'canonical_input',
                 jsonb_build_object('migrationRunId', 'vay1351-000000000000000000000000'))`,
        [PROPERTY_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.staleProvenanceCount).toBeGreaterThanOrEqual(1);

      await client.query(
        `UPDATE hotel_catalog.property_source_links
            SET status = 'superseded'
          WHERE property_id = $1`,
        [PROPERTY_ID],
      );
      const dispositioned = await readProductionParityEvidence(config());
      expect(dispositioned.staleProvenanceCount).toBe(0);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("detects a raw canonical-catalog media assignment directly", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-raw-property-media', 'Parity raw property media')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO hotel_catalog.property_media
           (id, property_id, media_type, url, source_system)
         VALUES ($1, $2, 'hero_image', 'https://legacy.example.test/raw-catalog.jpg', 'booking')`,
        [PROPERTY_MEDIA_ID, PROPERTY_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.rawLegacyMediaReferenceCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("accepts a canonical platform-media catalog assignment with an approved active variant", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-canonical-property-media', 'Parity canonical property media')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO platform.media_objects
           (id, bucket, storage_key, storage_kind, visibility, purpose, property_id, resource_product,
            resource_type, lifecycle_status, source_system, source_table, source_row_id,
            public_approved)
         VALUES ($1::uuid, 'platform-media-test',
                 'public/media/' || $1::uuid::text || '/original_safe/canonical.jpg',
                 'vayada_managed', 'public', 'property.hero_image', $2,
                 'hotel_catalog', 'property', 'active', 'booking', 'booking_hotels',
                 'canonical-hero', TRUE)`,
        [MEDIA_OBJECT_ID, PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO platform.media_variants
           (media_object_id, variant_name, visibility, storage_key, content_type, public_cdn_url)
         VALUES ($1::uuid, 'original_safe', 'public',
                 'public/media/' || $1::uuid::text || '/original_safe/canonical.jpg', 'image/jpeg',
                 'https://media.example.test/media/' || $1::uuid::text || '/original_safe/canonical.jpg')`,
        [MEDIA_OBJECT_ID],
      );
      await client.query(
        `INSERT INTO hotel_catalog.property_media
           (id, property_id, media_type, url, source_system, public_approved,
            platform_media_object_id)
         VALUES ($1, $2, 'hero_image', $3, 'platform', TRUE, $4)`,
        [PROPERTY_MEDIA_ID, PROPERTY_ID, `platform-media:${MEDIA_OBJECT_ID}`, MEDIA_OBJECT_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.rawLegacyMediaReferenceCount).toBe(0);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("accepts canonical private Catalog and PMS assignments without exposing legacy URLs", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await insertPrivateAssignments(client);

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.rawLegacyMediaReferenceCount).toBe(0);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  const invalidPrivateAssignments: Array<[string, PrivateAssignmentOptions, number]> = [
    ["stale migration provenance", { migrationRunId: STALE_RUN_ID }, 2],
    ["no completed migration ledger", { ledger: false }, 2],
    ["a completed ledger from another run", { ledgerRunId: STALE_RUN_ID }, 2],
    ["wrong private variant", { variantName: "thumbnail" }, 2],
    ["a Catalog object carrying the PMS purpose", { catalogPurpose: "pms.room_type.media" }, 1],
    ["a PMS object bound to another room", { roomResourceId: PROPERTY_ID }, 1],
    ["missing object checksum evidence", { integrity: "missing_catalog_checksum" }, 1],
    ["mismatched variant checksum evidence", { integrity: "mismatched_room_checksum" }, 1],
    ["a malformed Catalog content type", { catalogContentType: "not-a-mime" }, 1],
    ["a non-image PMS content type", { roomContentType: "text/plain" }, 1],
  ];

  it.each(invalidPrivateAssignments)(
    "rejects private assignments with %s",
    async (_case, options, expected) => {
      assertSafeTestDatabase(URL!);
      const client = new pg.Client({ connectionString: URL });
      await client.connect();
      try {
        await insertPrivateAssignments(client, options);

        const evidence = await readProductionParityEvidence(config());

        expect(evidence.rawLegacyMediaReferenceCount).toBeGreaterThanOrEqual(expected);
      } finally {
        await cleanup(client);
        await client.end();
      }
    },
  );

  it.each([
    [
      "virtual-hosted S3",
      "platform-media-test",
      `public/media/${MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
      `https://platform-media-test.s3.amazonaws.com/media/${MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
    ],
    [
      "regional virtual-hosted S3",
      "platform-media-test",
      `public/media/${MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
      `https://platform-media-test.s3.us-east-1.amazonaws.com/media/${MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
    ],
    [
      "regional path-style S3",
      "platform-media-test",
      `public/media/${MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
      `https://s3.us-east-1.amazonaws.com/platform-media-test/media/${MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
    ],
    [
      "wrong managed bucket",
      "wrong-media-bucket",
      `public/media/${MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
      `https://media.example.test/media/${MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
    ],
    [
      "cross-object storage path",
      "platform-media-test",
      `public/media/${OTHER_MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
      `https://media.example.test/media/${OTHER_MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
    ],
  ])("rejects a %s public media variant", async (_case, bucket, storageKey, publicUrl) => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-unmanaged-media', 'Parity unmanaged media')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO platform.media_objects
           (id, bucket, storage_key, storage_kind, visibility, purpose, property_id,
            resource_product, resource_type, lifecycle_status, public_approved)
         VALUES ($1, $2, $4, 'vayada_managed', 'public', 'property.hero_image', $3,
                 'hotel_catalog', 'property', 'active', TRUE)`,
        [MEDIA_OBJECT_ID, bucket, PROPERTY_ID, storageKey],
      );
      await client.query(
        `INSERT INTO platform.media_variants
           (media_object_id, variant_name, visibility, storage_key, content_type, public_cdn_url)
         VALUES ($1, 'original_safe', 'public', $2, 'image/jpeg', $3)`,
        [MEDIA_OBJECT_ID, storageKey, publicUrl],
      );
      await client.query(
        `INSERT INTO hotel_catalog.property_media
           (id, property_id, media_type, url, source_system, public_approved,
            platform_media_object_id)
         VALUES ($1, $2, 'hero_image', $3, 'platform', TRUE, $4)`,
        [PROPERTY_MEDIA_ID, PROPERTY_ID, `platform-media:${MEDIA_OBJECT_ID}`, MEDIA_OBJECT_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.rawLegacyMediaReferenceCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("detects Booking media assignments bound to the wrong purpose", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-invalid-booking-logo', 'Parity invalid Booking logo')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO platform.media_objects
           (id, bucket, storage_key, visibility, purpose, property_id, resource_product,
            resource_type, lifecycle_status, source_system, source_table, source_row_id,
            public_approved)
         VALUES ($1, 'test', 'parity/wrong-logo.jpg', 'public', 'property.hero_image', $2,
                 'hotel_catalog', 'property', 'active', 'booking', 'booking_hotels',
                 'wrong-booking-logo', TRUE)`,
        [MEDIA_OBJECT_ID, PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO platform.media_variants
           (media_object_id, variant_name, visibility, storage_key, content_type, public_cdn_url)
         VALUES ($1, 'original_safe', 'public', 'parity/wrong-logo.jpg', 'image/jpeg',
                 'https://cdn.example.test/parity/wrong-logo.jpg')`,
        [MEDIA_OBJECT_ID],
      );
      await client.query(
        `INSERT INTO booking.booking_settings (property_id, header_logo_media_object_id)
         VALUES ($1, $2)`,
        [PROPERTY_ID, MEDIA_OBJECT_ID],
      );
      await client.query(
        `INSERT INTO booking.addon_definitions
           (id, property_id, source_system, name, pricing_model, currency, metadata)
         VALUES ($1, $2, 'booking', 'Wrong media', 'per_stay', 'EUR',
                 jsonb_build_object(
                   'mediaObjectId', $3::text,
                   'imageUrl', 'https://cdn.example.test/parity/wrong-logo.jpg'
                 ))`,
        [ADDON_ID, PROPERTY_ID, MEDIA_OBJECT_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.rawLegacyMediaReferenceCount).toBeGreaterThanOrEqual(2);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("rejects a Booking add-on that points at a thumbnail instead of original_safe", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-addon-thumbnail', 'Parity add-on thumbnail')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO platform.media_objects
           (id, bucket, storage_key, storage_kind, visibility, purpose, property_id,
            resource_product, resource_type, resource_id, lifecycle_status, public_approved)
         VALUES ($1, 'platform-media-test',
                 'public/media/' || $1::uuid::text || '/original_safe/original.webp',
                 'vayada_managed', 'public', 'booking.addon.image', $2::uuid, 'booking',
                 'booking_hotel', $2::uuid::text, 'active', TRUE)`,
        [MEDIA_OBJECT_ID, PROPERTY_ID],
      );
      const thumbnailUrl = `https://media.example.test/media/${MEDIA_OBJECT_ID}/thumbnail/thumbnail.webp`;
      await client.query(
        `INSERT INTO platform.media_variants
           (media_object_id, variant_name, visibility, storage_key, content_type, public_cdn_url)
         VALUES ($1, 'thumbnail', 'public',
                 'public/media/' || $1::uuid::text || '/thumbnail/thumbnail.webp',
                 'image/webp', $2)`,
        [MEDIA_OBJECT_ID, thumbnailUrl],
      );
      await client.query(
        `INSERT INTO booking.addon_definitions
           (id, property_id, source_system, name, pricing_model, currency, metadata)
         VALUES ($1, $2, 'booking', 'Thumbnail add-on', 'per_stay', 'EUR',
                 jsonb_build_object('mediaObjectId', $3::text, 'imageUrl', $4::text))`,
        [ADDON_ID, PROPERTY_ID, MEDIA_OBJECT_ID, thumbnailUrl],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.rawLegacyMediaReferenceCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("rejects migrated Marketplace chat media without runtime migration evidence", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES
           ($1, 'creator_workspace', 'Parity creator', 'parity-creator'),
           ($2, 'hotel_group', 'Parity hotel', 'parity-hotel')`,
        [CREATOR_ORGANIZATION_ID, HOTEL_ORGANIZATION_ID],
      );
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-private-chat', 'Parity private chat')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO marketplace.creator_profiles (id, organization_id)
         VALUES ($1, $2)`,
        [CREATOR_PROFILE_ID, CREATOR_ORGANIZATION_ID],
      );
      await client.query(
        `INSERT INTO marketplace.marketplace_hotel_profiles (property_id, organization_id)
         VALUES ($1, $2)`,
        [PROPERTY_ID, HOTEL_ORGANIZATION_ID],
      );
      await client.query(
        `INSERT INTO marketplace.marketplace_offers
           (id, property_id, organization_id, title)
         VALUES ($1, $2, $3, 'Parity listing')`,
        [LISTING_ID, PROPERTY_ID, HOTEL_ORGANIZATION_ID],
      );
      await client.query(
        `INSERT INTO marketplace.collaborations
           (id, creator_profile_id, creator_organization_id, property_id,
            hotel_organization_id, offer_id, initiator_type)
         VALUES ($1, $2, $3, $4, $5, $6, 'hotel')`,
        [
          COLLABORATION_ID,
          CREATOR_PROFILE_ID,
          CREATOR_ORGANIZATION_ID,
          PROPERTY_ID,
          HOTEL_ORGANIZATION_ID,
          LISTING_ID,
        ],
      );
      await client.query(
        `INSERT INTO platform.media_objects
           (id, bucket, storage_key, storage_kind, visibility, purpose,
            owner_organization_id, property_id, resource_product, resource_type,
            resource_id, lifecycle_status, source_metadata, public_approved, retained_until)
         VALUES ($1::uuid, 'platform-media-test',
                 'private/media/' || $1::uuid::text || '/provider_original/chat.webp',
                 'vayada_managed', 'private', 'marketplace.collaboration_chat.attachment',
                 $2, $3, 'marketplace', 'collaboration_chat_message', $4::text,
                 'active', '{}'::jsonb, FALSE, now() + interval '1 year')`,
        [MEDIA_OBJECT_ID, CREATOR_ORGANIZATION_ID, PROPERTY_ID, MESSAGE_ID],
      );
      await client.query(
        `INSERT INTO platform.media_variants
           (media_object_id, variant_name, visibility, storage_key, content_type)
         VALUES ($1::uuid, 'provider_original', 'private',
                 'private/media/' || $1::uuid::text || '/provider_original/chat.webp', 'image/webp')`,
        [MEDIA_OBJECT_ID],
      );
      await client.query(
        `INSERT INTO marketplace.marketplace_chat_messages
           (id, collaboration_id, property_id, sender_type, message_type, body, message_metadata)
         VALUES ($1, $2, $3, 'creator', 'image', '[image attachment migrated]',
                 jsonb_build_object(
                   'mediaObjectId', $4::text,
                   'attachmentSource', 'platform_media_migration'
                 ))`,
        [MESSAGE_ID, COLLABORATION_ID, PROPERTY_ID, MEDIA_OBJECT_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.rawLegacyMediaReferenceCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("passes a cohort whose outside hotel keeps only the inert rows the writers leave", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      const cohort = await storeCohort(client, COHORT_PASS_RUN_ID, [IN_HOTEL_ID]);
      await insertCohortProperties(client, "canonical");
      await insertOutsideRows(client, false);
      await insertCohortAccess(client, false);

      const { cohortScope } = await readProductionParityEvidence({
        ...config(),
        sourceRunId: COHORT_PASS_RUN_ID,
      });

      expect(cohortScope).toMatchObject({
        cohortSha256: cohort.cohortSha256,
        approvalProofSha256: cohort.approvalProofSha256,
      });
      expect(cohortScope!.cohortProperties).toBeGreaterThanOrEqual(1);
      expect(cohortScope!.nonCohortProperties).toBeGreaterThanOrEqual(1);
      expect(cohortScope!.violations.filter((row) => COHORT_SUBJECTS.has(row.subjectId))).toEqual(
        [],
      );
      expect((await readProductionParityEvidence(config())).cohortScope).toBeNull();
    } finally {
      await cleanupCohort(client);
      await client.end();
    }
  });

  it("reports every cohort scope category when those rows are live", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await storeCohort(client, COHORT_FAIL_RUN_ID, [IN_HOTEL_ID, MISSING_HOTEL_ID]);
      await insertCohortProperties(client, "private_quarantine");
      await insertOutsideRows(client, true);
      await insertCohortAccess(client, true);

      const { cohortScope } = await readProductionParityEvidence({
        ...config(),
        sourceRunId: COHORT_FAIL_RUN_ID,
      });
      const mine = cohortScope!.violations.filter((row) => COHORT_SUBJECTS.has(row.subjectId));

      expect(mine).toEqual([
        { category: "actionablePayout", subjectId: OUT_HOTEL_ID },
        { category: "activeChannexMapping", subjectId: OUT_HOTEL_ID },
        { category: "activeEntitlement", subjectId: OUT_HOTEL_ID },
        { category: "activeMembership", subjectId: OUT_HOTEL_ID },
        { category: "activeOwnerLink", subjectId: OUT_HOTEL_ID },
        { category: "autoOpenNotDisabled", subjectId: OUT_HOTEL_ID },
        { category: "bindingClaim", subjectId: OUT_HOTEL_ID },
        { category: "cohortHotelUnresolved", subjectId: MISSING_HOTEL_ID },
        { category: "cohortPropertyEntitlement", subjectId: IN_HOTEL_ID },
        { category: "cohortPropertyOwner", subjectId: IN_HOTEL_ID },
        { category: "cohortPropertyQuarantined", subjectId: IN_HOTEL_ID },
        { category: "connectedChannel", subjectId: OUT_HOTEL_ID },
        { category: "enabledProviderAccount", subjectId: OUT_HOTEL_ID },
        { category: "marketplaceListing", subjectId: OUT_HOTEL_ID },
        { category: "profileNotPrivate", subjectId: OUT_HOTEL_ID },
        { category: "publicAddons", subjectId: OUT_HOTEL_ID },
        { category: "publicMedia", subjectId: OUT_HOTEL_ID },
        { category: "publicOffers", subjectId: OUT_HOTEL_ID },
        { category: "verifiedDomain", subjectId: OUT_HOTEL_ID },
      ]);
    } finally {
      await cleanupCohort(client);
      await client.end();
    }
  });

  it("requires an explicit calendar auto-open row matching each legacy choice", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    const run = COHORT_AUTO_OPEN_RUN_ID;
    const legacy = {
      id: IN_PMS_HOTEL_ID,
      calendar_auto_open_enabled: true,
      calendar_auto_open_mode: "fixed",
      calendar_auto_open_fixed_month: "2027-06-15",
    };
    try {
      await storeCohort(client, run, [IN_HOTEL_ID], [IN_PMS_HOTEL_ID]);
      await insertCohortProperties(client, "canonical");
      await client.query(
        `INSERT INTO hotel_catalog.property_source_links
           (property_id, source_system, source_table, source_id, relationship)
         VALUES ($1, 'pms', 'hotels', $2, 'operational_input')`,
        [IN_HOTEL_ID, IN_PMS_HOTEL_ID],
      );
      await client.query(
        `INSERT INTO platform.source_extraction_runs
           (run_id, environment, source_schema_revision, status, finished_at, duration_ms)
         VALUES ($1, 'local', $2, 'completed', now(), 1)`,
        [run, "1".repeat(40)],
      );
      await client.query(
        `INSERT INTO migration_source_pms.snapshot_rows (run_id, snapshot_identifier,
           source_schema, source_table, row_ordinal, row_checksum_sha256, row_data)
         VALUES ($1, 'parity', 'public', 'hotels', 1, $2, $3)`,
        [run, "5".repeat(64), legacy],
      );
      const autoOpen = async () =>
        (
          await readProductionParityEvidence({ ...config(), sourceRunId: run })
        ).cohortScope!.violations.filter((row) => /auto_?open/i.test(row.category));

      // No rows (on by default), then the outside hotel disabled but the cohort hotel carried
      // with the wrong month, then exactly as the import maps both.
      expect(await autoOpen()).toEqual([
        { category: "autoOpenNotDisabled", subjectId: OUT_HOTEL_ID },
        { category: "cohortAutoOpen", subjectId: IN_HOTEL_ID },
      ]);
      await client.query(
        `INSERT INTO pms.calendar_auto_open_settings
           (property_id, revision, enabled, mode, rolling_months, fixed_end_month)
         VALUES ($1, 1, TRUE, 'fixed', NULL, '2027-07-01'), ($2, 1, FALSE, 'rolling', 18, NULL)`,
        [IN_HOTEL_ID, OUT_HOTEL_ID],
      );
      expect(await autoOpen()).toEqual([{ category: "cohortAutoOpen", subjectId: IN_HOTEL_ID }]);
      await client.query(
        "UPDATE pms.calendar_auto_open_settings SET fixed_end_month = '2027-06-01' WHERE property_id = $1",
        [IN_HOTEL_ID],
      );
      expect(await autoOpen()).toEqual([]);
    } finally {
      await client.query("DELETE FROM migration_source_pms.snapshot_rows WHERE run_id = $1", [run]);
      await client.query("DELETE FROM platform.source_extraction_runs WHERE run_id = $1", [run]);
      await cleanupCohort(client);
      await client.end();
    }
  });

  it("holds a write freeze across the complete parity callback", async () => {
    assertSafeTestDatabase(URL!);
    const setup = new pg.Client({ connectionString: URL });
    await setup.connect();
    try {
      await setup.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-write-freeze', 'Parity write freeze')`,
        [PROPERTY_ID],
      );

      await expect(
        withProductionParityTargetWriteFreeze(config(), async () => {
          const competing = new pg.Client({ connectionString: URL });
          await competing.connect();
          try {
            await competing.query("SET lock_timeout = '100ms'");
            await expect(
              competing.query(
                "UPDATE hotel_catalog.properties SET display_name = 'Changed' WHERE id = $1",
                [PROPERTY_ID],
              ),
            ).rejects.toMatchObject({ code: "55P03" });
          } finally {
            await competing.end();
          }
          return true;
        }),
      ).resolves.toBe(true);
    } finally {
      await cleanup(setup);
      await setup.end();
    }
  });
});

function config(): ProductionParityConfig {
  return {
    connectionString: URL!,
    sourceRunId: RUN_ID,
    sourceTags: {
      auth: "fixture:auth",
      booking: "fixture:booking",
      marketplace: "fixture:marketplace",
      pms: "fixture:pms",
    },
    sourceEnvironment: "local",
    environment: "local",
    applicationRelease: "a".repeat(40),
    operator: "integration-test",
    warningBudget: 0,
    migrationsDir: MIGRATIONS_DIR,
    targetMediaBucket: "platform-media-test",
    mediaCdnBaseUrl: "https://media.example.test",
  };
}

async function cleanup(client: pg.Client): Promise<void> {
  await client.query("DELETE FROM booking.booking_settings WHERE property_id = $1", [PROPERTY_ID]);
  await client.query("DELETE FROM booking.addon_definitions WHERE property_id = $1", [PROPERTY_ID]);
  await client.query("DELETE FROM pms.room_type_media WHERE property_id = $1", [PROPERTY_ID]);
  await client.query("DELETE FROM pms.room_types WHERE property_id = $1", [PROPERTY_ID]);
  await client.query("DELETE FROM hotel_catalog.property_media WHERE property_id = $1", [
    PROPERTY_ID,
  ]);
  await client.query(
    "DELETE FROM platform.production_media_migration_runs WHERE source_run_id = ANY($1::text[])",
    [[RUN_ID, STALE_RUN_ID]],
  );
  await client.query("DELETE FROM platform.media_objects WHERE id = ANY($1::uuid[])", [
    [MEDIA_OBJECT_ID, ROOM_MEDIA_OBJECT_ID],
  ]);
  await client.query("DELETE FROM platform.source_extraction_runs WHERE run_id = ANY($1::text[])", [
    [RUN_ID, STALE_RUN_ID],
  ]);
  await client.query("DELETE FROM hotel_catalog.properties WHERE id = $1", [PROPERTY_ID]);
  await client.query("DELETE FROM marketplace.creator_profiles WHERE id = $1", [
    CREATOR_PROFILE_ID,
  ]);
  await client.query("DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])", [
    [CREATOR_ORGANIZATION_ID, HOTEL_ORGANIZATION_ID],
  ]);
}

async function storeCohort(
  client: pg.Client,
  sourceRunId: string,
  bookingHotelIds: string[],
  pmsHotelIds: string[] = [],
) {
  const cohort = parseProductionMigrationCohort({
    sourceRunId,
    bookingHotelIds,
    pmsHotelIds,
    marketplaceHotelIds: [],
    approvalProofSha256: "a".repeat(64),
  });
  await writeProductionMigrationCohort(client, cohort);
  return cohort;
}

async function insertCohortProperties(client: pg.Client, inDisposition: string): Promise<void> {
  await client.query(
    `INSERT INTO hotel_catalog.properties (id, public_id, display_name, profile_status)
     VALUES ($1, 'parity-cohort-in', 'Parity cohort hotel', 'complete'),
            ($2, 'parity-cohort-out', 'Parity outside hotel', 'private')`,
    [IN_HOTEL_ID, OUT_HOTEL_ID],
  );
  await client.query(
    `INSERT INTO hotel_catalog.property_source_links
       (property_id, source_system, source_table, source_id, relationship, metadata)
     VALUES ($1::uuid, 'booking', 'booking_hotels', $1::uuid::text, 'canonical_input',
             jsonb_build_object('migrationDisposition', $4::text)),
            ($2::uuid, 'booking', 'booking_hotels', $2::uuid::text, 'canonical_input',
             '{"migrationDisposition":"private_quarantine"}'::jsonb),
            ($2::uuid, 'pms', 'hotels', $3::text, 'operational_input',
             '{"migrationDisposition":"private_quarantine"}'::jsonb)`,
    [IN_HOTEL_ID, OUT_HOTEL_ID, OUT_PMS_HOTEL_ID, inDisposition],
  );
}

/** The rows a property outside the cohort keeps: inert as the domain writers leave them, or live. */
async function insertOutsideRows(client: pg.Client, live: boolean): Promise<void> {
  const [out, org, pms] = [OUT_HOTEL_ID, OUT_ORGANIZATION_ID, OUT_PMS_HOTEL_ID];
  const pick = (liveValue: unknown, inertValue: unknown) => (live ? liveValue : inertValue);
  const statements: Array<[string, unknown[]]> = [
    [
      "UPDATE hotel_catalog.properties SET profile_status = $2 WHERE id = $1",
      [out, pick("complete", "private")],
    ],
    [
      `INSERT INTO hotel_catalog.property_public_profile_read_model
        (property_id, public_id, display_name, canonical_slug, default_locale, supported_locales,
         profile_status, verified_custom_domain)
      VALUES ($1, 'parity-cohort-out', 'Parity outside hotel', 'parity-cohort-out', 'en',
              ARRAY['en'], $2, $3)`,
      [out, pick("complete", "private"), pick("out.example.test", null)],
    ],
    [
      `INSERT INTO hotel_catalog.property_domains (property_id, hostname, verification_status)
      VALUES ($1, 'parity-cohort-out.example.test', $2)`,
      [out, pick("verified", "disabled")],
    ],
    [
      `INSERT INTO hotel_catalog.property_media
        (property_id, media_type, url, source_system, public_approved)
      VALUES ($1, 'hero_image', 'https://legacy.example.test/out.jpg', 'booking', $2)`,
      [out, live],
    ],
    [
      `INSERT INTO booking.promo_definitions
        (property_id, code, discount_type, discount_value, is_active, status)
      VALUES ($1, 'PARITY', 'percentage', 10, $2, $3)`,
      [out, live, pick("active", "retired")],
    ],
    [
      `INSERT INTO booking.addon_definitions
        (property_id, source_system, name, pricing_model, currency, public_visible, status)
      VALUES ($1, 'booking', 'Add-on', 'per_stay', 'EUR', $2, $3)`,
      [out, live, pick("active", "disabled")],
    ],
    [
      "INSERT INTO identity.users (id, email) VALUES ($1, 'parity-cohort-owner@example.test')",
      [OUT_USER_ID],
    ],
    [
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
      VALUES ($1, 'hotel_group', 'Parity outside owner', 'parity-cohort-out-owner', $2)`,
      [org, pick("active", "archived")],
    ],
    [
      `INSERT INTO identity.organization_memberships
        (organization_id, user_id, role_key, access_origin, status)
      VALUES ($1, $2, 'manager', 'agency', $3)`,
      [org, OUT_USER_ID, pick("active", "inactive")],
    ],
    // The PMS source ID, not the property ID, carries the owner path.
    [
      `INSERT INTO identity.organization_resource_links
        (organization_id, product, resource_type, resource_id, relationship, status)
      VALUES ($1, 'pms', 'pms_hotel', $2, 'operator', $3)`,
      [org, pms, pick("active", "archived")],
    ],
    [
      `INSERT INTO identity.product_entitlements
        (organization_id, product, entitlement_key, resource_product, resource_type, resource_id, status)
      VALUES ($1, 'pms', 'pms', 'pms', 'pms_hotel', $2, $3)`,
      [org, pms, pick("active", "expired")],
    ],
    [
      `INSERT INTO marketplace.marketplace_hotel_profiles
        (property_id, organization_id, marketplace_profile_status)
      VALUES ($1, $2, $3)`,
      [out, org, pick("verified", "archived")],
    ],
    [
      `INSERT INTO marketplace.marketplace_offers (id, property_id, organization_id, title, offer_status)
      VALUES ($1, $2, $3, 'Parity outside listing', $4)`,
      [OUT_OFFER_ID, out, org, pick("verified", "archived")],
    ],
    [
      `INSERT INTO pms.room_types (id, property_id, name, base_rate_amount, currency)
      VALUES ($1, $2, 'Parity outside room', 0, 'EUR')`,
      [OUT_ROOM_TYPE_ID, out],
    ],
    [
      `INSERT INTO pms.channel_connections (id, property_id, provider, connection_status)
      VALUES ($1, $2, 'custom', $3)`,
      [OUT_CONNECTION_ID, out, pick("degraded", "disconnected")],
    ],
    [
      `INSERT INTO pms.channel_room_type_mappings
        (property_id, connection_id, room_type_id, external_room_type_id, status)
      VALUES ($1, $2, $3, 'parity-room', $4)`,
      [out, OUT_CONNECTION_ID, OUT_ROOM_TYPE_ID, pick("active", "disabled")],
    ],
    [
      `INSERT INTO pms.channel_binding_claims
        (property_id, provider, external_property_id, claim_state, claim_source)
      VALUES ($1, 'channex', 'parity-cohort-channex', $2, 'migration')`,
      [out, pick("historical", "released")],
    ],
    [
      `INSERT INTO finance.payment_provider_accounts
        (property_id, account_scope, provider, charges_enabled, status)
      VALUES ($1, 'property', 'manual', $2, $3)`,
      [out, live, pick("active", "disabled")],
    ],
    [
      `INSERT INTO finance.payouts (owner_scope, property_id, payout_status, amount, currency)
      VALUES ('property', $1, $2, 1, 'EUR')`,
      [out, pick("scheduled", "canceled")],
    ],
    [
      `INSERT INTO pms.calendar_auto_open_settings (property_id, revision, enabled, mode, rolling_months)
      VALUES ($1, 1, $2, 'rolling', 18)`,
      [out, live],
    ],
  ];
  for (const [sql, params] of statements) await client.query(sql, params);
}

/** The cohort hotel's native access as the catalog step writes it. Live adds a second
 * organization holding both links, and a suspended organization-wide PMS entitlement as the
 * only failing grant: the second organization holds an active one. */
async function insertCohortAccess(client: pg.Client, live: boolean): Promise<void> {
  await client.query(
    `INSERT INTO identity.organizations (id, kind, name, slug, status)
     VALUES ($1, 'hotel_group', 'Parity cohort owner', 'parity-cohort-in-owner', 'active')`,
    [IN_ORGANIZATION_ID],
  );
  const organizations = live ? [IN_ORGANIZATION_ID, OUT_ORGANIZATION_ID] : [IN_ORGANIZATION_ID];
  await client.query(
    `INSERT INTO identity.organization_resource_links
       (organization_id, product, resource_type, resource_id, relationship, status)
     SELECT organization_id, product, resource_type, $2, 'owner', 'active'
       FROM unnest($1::uuid[]) organization_id, (VALUES ('hotel_catalog', 'property'),
            ('pms', 'pms_property')) AS native(product, resource_type)`,
    [organizations, IN_HOTEL_ID],
  );
  await client.query(
    `INSERT INTO identity.product_entitlements
       (organization_id, product, entitlement_key, status, resource_product, resource_type,
        resource_id)
     VALUES ($1, 'pms', 'property-management', 'active', 'pms', 'pms_property', $2)`,
    [IN_ORGANIZATION_ID, IN_HOTEL_ID],
  );
  if (live)
    await client.query(
      `INSERT INTO identity.product_entitlements (organization_id, product, entitlement_key, status)
       VALUES ($1, 'pms', 'property-management', 'suspended'),
              ($2, 'pms', 'property-management', 'active')`,
      [IN_ORGANIZATION_ID, OUT_ORGANIZATION_ID],
    );
}

async function cleanupCohort(client: pg.Client): Promise<void> {
  const properties = [IN_HOTEL_ID, OUT_HOTEL_ID];
  for (const table of [
    "finance.payouts",
    "finance.payment_provider_accounts",
    "pms.channel_binding_claims",
    "pms.channel_room_type_mappings",
    "pms.channel_connections",
    "pms.room_types",
    "marketplace.marketplace_offers",
    "marketplace.marketplace_hotel_profiles",
    "booking.addon_definitions",
    "booking.promo_definitions",
    "hotel_catalog.property_media",
    "hotel_catalog.property_domains",
    "hotel_catalog.property_public_profile_read_model",
  ])
    await client.query(`DELETE FROM ${table} WHERE property_id = ANY($1::uuid[])`, [properties]);
  for (const table of [
    "identity.product_entitlements",
    "identity.organization_resource_links",
    "identity.organization_memberships",
  ])
    await client.query(`DELETE FROM ${table} WHERE organization_id = ANY($1::uuid[])`, [
      [OUT_ORGANIZATION_ID, IN_ORGANIZATION_ID],
    ]);
  await client.query("DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])", [
    [OUT_ORGANIZATION_ID, IN_ORGANIZATION_ID],
  ]);
  await client.query("DELETE FROM identity.users WHERE id = $1", [OUT_USER_ID]);
  await client.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
    properties,
  ]);
}

type PrivateAssignmentOptions = {
  migrationRunId?: string;
  variantName?: string;
  catalogPurpose?: string;
  roomResourceId?: string;
  catalogContentType?: string;
  roomContentType?: string;
  ledger?: boolean;
  ledgerRunId?: string;
  integrity?: "missing_catalog_checksum" | "mismatched_room_checksum";
};

async function insertPrivateAssignments(
  client: pg.Client,
  options: PrivateAssignmentOptions = {},
): Promise<void> {
  const migrationRunId = options.migrationRunId ?? RUN_ID;
  const variantName = options.variantName ?? "provider_original";
  const catalogContentType = options.catalogContentType ?? "image/webp";
  const roomContentType = options.roomContentType ?? "image/webp";
  const catalogChecksum = "a".repeat(64);
  const roomChecksum = "b".repeat(64);
  const catalogStorageKey = `private/media/${MEDIA_OBJECT_ID}/provider_original/sha256-${catalogChecksum}.webp`;
  const roomStorageKey = `private/media/${ROOM_MEDIA_OBJECT_ID}/provider_original/sha256-${roomChecksum}.webp`;
  await client.query(
    `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
     VALUES ($1, 'parity-private-property-media', 'Parity private property media')`,
    [PROPERTY_ID],
  );
  await client.query(
    `INSERT INTO pms.room_types (id, property_id, name, base_rate_amount, currency)
     VALUES ($1, $2, 'Parity private room', 0, 'EUR')`,
    [ROOM_TYPE_ID, PROPERTY_ID],
  );
  await client.query(
    `INSERT INTO platform.media_objects
       (id, bucket, storage_key, storage_kind, visibility, purpose, property_id,
        resource_product, resource_type, resource_id, lifecycle_status, source_system,
        source_table, source_row_id, source_metadata, public_approved, content_type,
        size_bytes, checksum_sha256)
     VALUES
       ($1::uuid, 'platform-media-test', $2, 'vayada_managed', 'private', $3, $4,
        'hotel_catalog', 'property', $4::uuid::text, 'active', 'marketplace',
        'hotel_profiles', 'private-hero', jsonb_build_object('migrationRunId', $5::text),
        FALSE, $11, 123, $6),
       ($7::uuid, 'platform-media-test', $8, 'vayada_managed', 'private',
        'pms.room_type.media', $4, 'pms', 'room_type', $9::uuid::text, 'active', 'pms',
        'room_types', 'private-room', jsonb_build_object('migrationRunId', $5::text),
        FALSE, $12, 456, $10)`,
    [
      MEDIA_OBJECT_ID,
      catalogStorageKey,
      options.catalogPurpose ?? "property.hero_image",
      PROPERTY_ID,
      migrationRunId,
      options.integrity === "missing_catalog_checksum" ? null : catalogChecksum,
      ROOM_MEDIA_OBJECT_ID,
      roomStorageKey,
      options.roomResourceId ?? ROOM_TYPE_ID,
      roomChecksum,
      catalogContentType,
      roomContentType,
    ],
  );
  await client.query(
    `INSERT INTO platform.media_variants
       (media_object_id, variant_name, visibility, storage_key, content_type,
        size_bytes, checksum_sha256)
     VALUES
       ($1::uuid, $2, 'private', $3, $8, 123, $4),
       ($5::uuid, $2, 'private', $6, $9, 456, $7)`,
    [
      MEDIA_OBJECT_ID,
      variantName,
      catalogStorageKey,
      catalogChecksum,
      ROOM_MEDIA_OBJECT_ID,
      roomStorageKey,
      options.integrity === "mismatched_room_checksum" ? "c".repeat(64) : roomChecksum,
      catalogContentType,
      roomContentType,
    ],
  );
  if (options.ledger !== false)
    await insertPrivateMediaLedger(client, {
      sourceRunId: options.ledgerRunId ?? migrationRunId,
      catalogPurpose: options.catalogPurpose ?? "property.hero_image",
      catalogChecksum,
      roomChecksum,
    });
  await client.query(
    `INSERT INTO hotel_catalog.property_media
       (id, property_id, media_type, url, source_system, public_approved,
        platform_media_object_id)
     VALUES ($1, $2, 'hero_image', $3, 'platform', FALSE, $4)`,
    [PROPERTY_MEDIA_ID, PROPERTY_ID, `platform-media:${MEDIA_OBJECT_ID}`, MEDIA_OBJECT_ID],
  );
  await client.query(
    `INSERT INTO pms.room_type_media
       (property_id, room_type_id, platform_media_object_id, sort_order)
     VALUES ($1, $2, $3, 0)`,
    [PROPERTY_ID, ROOM_TYPE_ID, ROOM_MEDIA_OBJECT_ID],
  );
}

async function insertPrivateMediaLedger(
  client: pg.Client,
  input: {
    sourceRunId: string;
    catalogPurpose: string;
    catalogChecksum: string;
    roomChecksum: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.source_extraction_runs
       (run_id, environment, source_schema_revision, status, finished_at, duration_ms)
     VALUES ($1, 'local', $2, 'completed', now(), 1)`,
    [input.sourceRunId, "1".repeat(40)],
  );
  await client.query(
    `INSERT INTO platform.production_media_migration_runs
       (source_run_id, inventory_sha256, config_sha256, status, planned_count,
        completed_count, report_checksum_sha256, completed_at)
     VALUES ($1, $2, $3, 'completed', 2, 2, $4, now())`,
    [input.sourceRunId, "2".repeat(64), "3".repeat(64), "4".repeat(64)],
  );
  await client.query(
    `INSERT INTO platform.production_media_migration_items
       (source_run_id, source_system, source_table, source_row_id, purpose,
        source_field, source_url, source_updated_at, source_reference_sha256,
        media_object_id, item_status, content_checksum_sha256, size_bytes,
        evidence, completed_at)
     VALUES
       ($1, 'marketplace', 'hotel_profiles', 'private-hero', $2, 'hero_image',
        'https://legacy.example.test/private-hero.webp', $3, $4, $5, 'completed',
        $6, 123, '{}'::jsonb, now()),
       ($1, 'pms', 'room_types', 'private-room', 'pms.room_type.media', 'media',
        'https://legacy.example.test/private-room.webp', $3, $7, $8, 'completed',
        $9, 456, '{}'::jsonb, now())`,
    [
      input.sourceRunId,
      input.catalogPurpose,
      "2026-01-01T00:00:00.000Z",
      "5".repeat(64),
      MEDIA_OBJECT_ID,
      input.catalogChecksum,
      "6".repeat(64),
      ROOM_MEDIA_OBJECT_ID,
      input.roomChecksum,
    ],
  );
}
