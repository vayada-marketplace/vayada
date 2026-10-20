import { PUBLIC_BOOKABILITY_FIXTURES } from "@vayada/domain-distribution/fixtures";
import { buildBookingPublicContent } from "@vayada/domain-distribution/booking-publication";
import pg, { type QueryResultRow } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createActiveBookingPublicationProfileRepository } from "./routes/activeBookingPublicationProfile.js";
import {
  resolveTargetCheckoutProperty,
  resolveTargetHistoricalBookingProperty,
} from "./routes/bookingWebPublic.js";
import {
  configureActiveBookingPublicationGate,
  lockActiveBookingPublication,
} from "./domains/activeBookingPublicationGate.js";
import type { PublicHotelProfileReadPool } from "./routes/aiHotels.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const userId = "85858585-8585-4585-8585-858585858501";
const propertyA = "85858585-8585-4585-8585-858585858502";
const propertyB = "85858585-8585-4585-8585-858585858503";
const revisionA = "85858585-8585-4585-8585-858585858504";
const revisionB = "85858585-8585-4585-8585-858585858505";
const inactiveRevision = "85858585-8585-4585-8585-858585858506";
const malformedRevision = "85858585-8585-4585-8585-858585858507";
const legacyProperty = "85858585-8585-4585-8585-858585858509";
const legacyRevision = "85858585-8585-4585-8585-858585858510";
const hostname = "book.alpenrose.example";
const legacyHostname = "book.legacy-alpenrose.example";
const fixture = PUBLIC_BOOKABILITY_FIXTURES.find(({ caseId }) => caseId === "custom_domain")!;

describe.skipIf(!TEST_DATABASE_URL)("active Booking publication reads in PostgreSQL", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const pool: PublicHotelProfileReadPool = {
    async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
      return (await admin.query(text, values as unknown[])) as { rows: T[] };
    },
    async end() {},
  };
  const repository = createActiveBookingPublicationProfileRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    pool,
  });

  beforeAll(async () => {
    assertTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
    await admin.query("BEGIN");
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'active-profile@example.test', 'Active Profile Test', 'active')`,
      [userId],
    );
    await seedProperty(propertyA, revisionA, "hotel-alpenrose");
    await seedProperty(propertyB, revisionB, "hotel-alpenrose-next");
    await seedRevision(propertyA, inactiveRevision, "inactive-alpenrose", 2, false);
    await seedRedirect(propertyA, "former-alpenrose", "hotel-alpenrose");
    await assignDomain(propertyA);
  });

  beforeEach(async () => admin.query("SAVEPOINT active_profile_test"));
  afterEach(async () => admin.query("ROLLBACK TO SAVEPOINT active_profile_test"));

  afterAll(async () => {
    await admin.query("ROLLBACK");
    await admin.end();
  });

  it("stops serving a revoked domain and follows a verified reassignment", async () => {
    await expect(repository.findProfileByCustomDomain?.(hostname)).resolves.toMatchObject({
      hotel: { propertyId: propertyA },
    });
    await expect(repository.findProfileBySlug("hotel-alpenrose")).resolves.toMatchObject({
      hotel: { propertyId: propertyA },
    });

    await admin.query("DELETE FROM hotel_catalog.property_domains WHERE hostname = $1", [hostname]);
    await expect(repository.findProfileByCustomDomain?.(hostname)).resolves.toBeNull();
    await expect(repository.findProfileBySlug("hotel-alpenrose")).resolves.toBeNull();

    await assignDomain(propertyB);
    await expect(repository.findProfileByCustomDomain?.(hostname)).resolves.toMatchObject({
      hotel: { propertyId: propertyB },
    });
  });

  it("resolves Catalog redirects only through the pointed active revision", async () => {
    await expect(repository.findProfileBySlug("former-alpenrose")).resolves.toMatchObject({
      hotel: { propertyId: propertyA, slug: "hotel-alpenrose" },
    });
    await expect(repository.findProfileBySlug("inactive-alpenrose")).resolves.toBeNull();
  });

  it("finds a hotel's bookings by its former address (VAY-2295)", async () => {
    for (const slug of ["hotel-alpenrose", "former-alpenrose"]) {
      await expect(resolveTargetHistoricalBookingProperty(pool, slug)).resolves.toMatchObject({
        propertyId: propertyA,
      });
    }
    await admin.query(
      `UPDATE hotel_catalog.property_slugs SET status = 'retired', redirects_to_id = NULL
       WHERE slug = 'former-alpenrose'`,
    );
    await expect(
      resolveTargetHistoricalBookingProperty(pool, "former-alpenrose"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("keeps selling under former addresses across an address change (VAY-2295)", async () => {
    await admin.query(
      "UPDATE hotel_catalog.properties SET lifecycle_status = 'active' WHERE id = $1::uuid",
      [propertyA],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
       VALUES ($1::uuid, 'Europe/Vienna')`,
      [propertyA],
    );
    const gate = (slug: string) =>
      lockActiveBookingPublication(admin, slug, propertyA, { manualPayments: false });
    const sells = async (slug: string) => {
      await expect(gate(slug)).resolves.toBe("visible");
      await expect(resolveTargetCheckoutProperty(pool, slug)).resolves.toMatchObject({
        propertyId: propertyA,
      });
    };
    const refuses = async (slug: string) => {
      await expect(gate(slug)).resolves.toBe("hidden");
      await expect(resolveTargetCheckoutProperty(pool, slug)).rejects.toMatchObject({
        statusCode: 404,
      });
    };
    configureActiveBookingPublicationGate({ servesPublications: true, manualPayments: false });
    try {
      await sells("hotel-alpenrose");
      await sells("former-alpenrose");

      // The address moves on before the page is rebuilt, so the page still carries the old one.
      await admin.query(
        "UPDATE hotel_catalog.property_slugs SET status = 'retired' WHERE slug = 'hotel-alpenrose'",
      );
      await admin.query(
        `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status)
         VALUES ($1::uuid, 'alpenrose-lodge', 'canonical', 'active')`,
        [propertyA],
      );
      await admin.query(
        `UPDATE hotel_catalog.property_slugs
         SET purpose = 'redirect', status = 'redirected',
             redirects_to_id = (SELECT id FROM hotel_catalog.property_slugs WHERE slug = 'alpenrose-lodge')
         WHERE slug IN ('hotel-alpenrose', 'former-alpenrose')`,
      );
      for (const slug of ["alpenrose-lodge", "hotel-alpenrose", "former-alpenrose"]) {
        await sells(slug);
      }

      // A page whose own address was retired sells under none of them.
      await admin.query(
        `UPDATE hotel_catalog.property_slugs SET status = 'retired', redirects_to_id = NULL
         WHERE slug = 'hotel-alpenrose'`,
      );
      for (const slug of ["alpenrose-lodge", "former-alpenrose", "hotel-alpenrose"]) {
        await refuses(slug);
      }
    } finally {
      configureActiveBookingPublicationGate({ servesPublications: false, manualPayments: false });
    }
  });

  it("fails closed when the active revision omits required public content", async () => {
    await admin.query(
      `INSERT INTO distribution.public_booking_content_revisions (
         id, property_id, revision_number, readiness_contract_version,
         source_manifest, source_manifest_hash, readiness_hash,
         readiness_product, readiness_status, public_content, built_by_user_id
       )
       SELECT $2::uuid, property_id, 3, readiness_contract_version,
              source_manifest, source_manifest_hash, readiness_hash,
              readiness_product, readiness_status,
              jsonb_build_object(
                'contractVersion', 'booking-public-content.v1',
                'profile', public_content -> 'profile'
              ),
              built_by_user_id
       FROM distribution.public_booking_content_revisions
       WHERE id = $1::uuid`,
      [revisionA, malformedRevision],
    );
    await admin.query(
      `UPDATE distribution.active_public_booking_revision
       SET content_revision_id = $2::uuid
       WHERE property_id = $1::uuid`,
      [propertyA, malformedRevision],
    );
    await expect(repository.findProfileBySlug("hotel-alpenrose")).resolves.toBeNull();
  });

  it("keeps a hotel that never published online from its legacy page (VAY-2186)", async () => {
    await seedLegacyProperty(legacyProperty, "legacy-alpenrose");
    configureActiveBookingPublicationGate({ servesPublications: true, manualPayments: false });
    try {
      await expect(repository.findProfileBySlug("legacy-alpenrose")).resolves.toMatchObject({
        hotel: { propertyId: legacyProperty, slug: "legacy-alpenrose" },
      });
      await expect(repository.findProfileByCustomDomain?.(legacyHostname)).resolves.toMatchObject({
        hotel: { propertyId: legacyProperty },
      });
      // Checkout agrees with the page.
      await expect(resolveTargetCheckoutProperty(pool, "legacy-alpenrose")).resolves.toMatchObject({
        propertyId: legacyProperty,
      });

      // Once it publishes, only the publication counts, even one the legacy lookup can't reach: this
      // one has another slug and names a custom domain the hotel hasn't verified, so it is hidden.
      await seedRevision(legacyProperty, legacyRevision, "legacy-alpenrose-next", 1, true);
      await expect(repository.findProfileBySlug("legacy-alpenrose")).resolves.toBeNull();
      await expect(repository.findProfileByCustomDomain?.(legacyHostname)).resolves.toBeNull();
      await expect(resolveTargetCheckoutProperty(pool, "legacy-alpenrose")).rejects.toMatchObject({
        statusCode: 404,
      });
    } finally {
      configureActiveBookingPublicationGate({ servesPublications: false, manualPayments: false });
    }
  });

  it("says guests can enter promo codes only while the Promos switch is on (VAY-2200)", async () => {
    const promoCodes = async () =>
      (await repository.findProfileBySlug("hotel-alpenrose"))?.hotel.capabilities.promoCodes;
    // Read live, whatever the published revision said; no booking settings row keeps it on.
    expect(await promoCodes()).toBe(true);
    await admin.query(
      "INSERT INTO booking.booking_settings (property_id, promo_codes_enabled) VALUES ($1::uuid, FALSE)",
      [propertyA],
    );
    expect(await promoCodes()).toBe(false);
    await admin.query(
      "UPDATE booking.booking_settings SET promo_codes_enabled = TRUE WHERE property_id = $1::uuid",
      [propertyA],
    );
    expect(await promoCodes()).toBe(true);
  });

  async function seedLegacyProperty(propertyId: string, slug: string): Promise<void> {
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name, lifecycle_status)
       VALUES ($1::uuid, $2, 'Legacy Alpenrose', 'active')`,
      [propertyId, slug],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status)
       VALUES ($1::uuid, $2, 'canonical', 'active')`,
      [propertyId, slug],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
       VALUES ($1::uuid, 'Europe/Vienna')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_domains
         (property_id, hostname, verification_status, canonical_when_verified, verified_at)
       VALUES ($1::uuid, $2, 'verified', TRUE, now())`,
      [propertyId, legacyHostname],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_public_profile_read_model
         (property_id, public_id, display_name, canonical_slug, default_locale,
          supported_locales, profile_status)
       VALUES ($1::uuid, $2, 'Legacy Alpenrose', $2, 'en', ARRAY['en'], 'complete')`,
      [propertyId, slug],
    );
    await admin.query(
      `INSERT INTO distribution.public_hotel_bookability_profiles
         (property_id, public_id, canonical_slug, canonical_url, booking_base_url,
          custom_domain_url, timezone, default_currency, supported_currencies, profile_status,
          freshness_status, public_identity, public_setup_completeness, capabilities)
       VALUES ($1::uuid, $2, $2, $3 || '/en', $3, $3, 'Europe/Vienna', 'EUR', ARRAY['EUR'],
               'public', 'fresh',
               jsonb_build_object('propertyId', $1::text, 'slug', $2::text, 'name', 'Legacy Alpenrose'),
               '{"status":"ready"}', '{"paymentMethods":["pay_at_property"]}')`,
      [propertyId, slug, `https://${legacyHostname}`],
    );
  }

  async function seedProperty(propertyId: string, revisionId: string, slug: string): Promise<void> {
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, $3)`,
      [propertyId, slug, `Active ${slug}`],
    );
    await seedRevision(propertyId, revisionId, slug, 1, true);
  }

  async function seedRevision(
    propertyId: string,
    revisionId: string,
    slug: string,
    revisionNumber: number,
    active: boolean,
  ): Promise<void> {
    const profile = structuredClone(fixture.profile);
    profile.hotel.propertyId = propertyId;
    profile.hotel.slug = slug;
    profile.hotel.name = `Active ${slug}`;
    const sourceManifest = {
      contractVersion: "onboarding-source-manifest.v1",
      propertyId,
      sources: [{ owner: "hotel_catalog", entityId: propertyId, revision: String(revisionNumber) }],
    };
    await admin.query(
      `INSERT INTO distribution.public_booking_content_revisions (
         id, property_id, revision_number, readiness_contract_version,
         source_manifest, source_manifest_hash, readiness_hash,
         readiness_product, readiness_status, public_content, built_by_user_id
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'onboarding-product-readiness.v1',
         $4::jsonb, $5, $6, 'booking', 'ready', $7::jsonb, $8::uuid
       )`,
      [
        revisionId,
        propertyId,
        revisionNumber,
        JSON.stringify(sourceManifest),
        `sha256:${"1".repeat(64)}`,
        `sha256:${"2".repeat(64)}`,
        JSON.stringify(publicContent(profile)),
        userId,
      ],
    );
    if (active) {
      await admin.query(
        `INSERT INTO distribution.active_public_booking_revision
           (property_id, content_revision_id, activated_by_user_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        [propertyId, revisionId, userId],
      );
    }
  }

  async function seedRedirect(propertyId: string, redirect: string, canonical: string) {
    await admin.query(
      `WITH target AS (
         INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status)
         VALUES ($1::uuid, $2, 'canonical', 'active')
         RETURNING id
       )
       INSERT INTO hotel_catalog.property_slugs
         (property_id, slug, purpose, status, redirects_to_id)
       SELECT $1::uuid, $3, 'redirect', 'redirected', id FROM target`,
      [propertyId, canonical, redirect],
    );
  }

  async function assignDomain(propertyId: string): Promise<void> {
    await admin.query(
      `INSERT INTO hotel_catalog.property_domains
         (property_id, hostname, verification_status, canonical_when_verified, verified_at)
       VALUES ($1::uuid, $2, 'verified', TRUE, now())`,
      [propertyId, hostname],
    );
  }
});

function publicContent(profile: (typeof fixture)["profile"]) {
  const result = buildBookingPublicContent({
    sourceManifestHash: `sha256:${"1".repeat(64)}`,
    readinessHash: `sha256:${"2".repeat(64)}`,
    profile,
    rooms: [
      {
        roomTypeId: "room-1",
        name: "Room",
        description: "A room.",
        category: null,
        occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
        beds: [{ type: "double", quantity: 1 }],
        bedrooms: 1,
        bathrooms: 1,
        bathroomType: "private",
        size: null,
        images: [{ url: "https://cdn.example/room.jpg" }],
        amenities: ["wifi"],
        rates: [
          {
            ratePlanId: "rate-1",
            currency: "EUR",
            baseNightlyAmount: "100.00",
            refundable: true,
            paymentTiming: "pay_at_property",
          },
        ],
      },
    ],
    calendar: {
      sourceRevision: "calendar-1",
      materializedRevision: "calendar-1",
      currentLocalDate: "2026-06-06",
      coverageFrom: "2026-06-06",
      coverageThrough: "2027-06-06",
      materializedThrough: "2027-06-06",
      expectedDayCount: 366,
      materializedDayCount: 366,
      gapCount: 0,
      roomTypeIds: ["room-1"],
      observedAt: profile.generatedAt,
    },
    finance: {
      defaultCurrency: "EUR",
      supportedCurrencies: ["EUR"],
      onlinePayment: true,
      payAtProperty: true,
      readyPaymentMethods: ["card", "pay_at_property"],
    },
  });
  if (!result) throw new Error("Expected valid Booking public content fixture");
  return result.publicContent;
}

function assertTestDatabase(connectionString: string): void {
  const database = new URL(connectionString).pathname.slice(1);
  if (!database.toLowerCase().includes("test")) {
    throw new Error("Active publication integration tests require a test database");
  }
}
