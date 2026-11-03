import { createHash, randomUUID } from "node:crypto";

import { FIRST_RUN_GUEST_TERMS } from "@vayada/domain-booking";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { createPgHotelSetupChecklistRepository } from "./domains/hotelSetupChecklistRepository.js";
import { createHotelSetupOrdinaryLoginFixture } from "./hotelSetupOrdinaryLogin.fixture.js";

const url = process.env["TEST_DATABASE_URL"];

/**
 * VAY-2247 wave 2: the checklist's facts and its two writes (migration 0503) on the real database, read and
 * written by the ordinary API login, as in production. Fixture rows are written by the test's own login with
 * triggers and foreign keys off; the repository runs with every constraint on.
 */
describe.skipIf(!url)("hotel setup checklist on the real database (VAY-2247)", () => {
  async function setUp() {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const login = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    const pool = new pg.Pool({ connectionString: login.connectionString, max: 2 });
    const repository = createPgHotelSetupChecklistRepository(pool);
    const [owner, manager] = [randomUUID(), randomUUID()];
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    for (const [id, email] of [
      [owner, `owner-${suffix}@example.test`],
      [manager, `manager-${suffix}@example.test`],
    ])
      await admin.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'active')", [
        id,
        email,
      ]);

    /** A hotel whose basics are complete, and nothing else. */
    async function hotel() {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO hotel_catalog.properties
           (id, public_id, display_name, default_locale, lifecycle_status, lifecycle_revision,
            profile_status, completeness_reasons)
         VALUES ($1, $2, 'Checklist hotel', 'en', 'active', 1, 'complete', '{}')`,
        [id, `checklist-${id}`],
      );
      return id;
    }
    const actor = (propertyId: string, userId = owner) => ({
      organizationId: randomUUID(),
      propertyId,
      userId,
      requestId: `req-${suffix}`,
      correlationId: null,
      requestedAt: new Date().toISOString(),
    });
    /** Writes fixture rows with triggers and foreign keys off. */
    async function fixture(write: () => Promise<unknown>) {
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL session_replication_role = replica");
        await write();
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    }
    async function publicImage(propertyId: string, mediaType: "hero_image" | "logo") {
      const mediaId = randomUUID();
      const checksum = createHash("sha256").update(`${mediaId}:original_safe`).digest("hex");
      const path = `media/${mediaId}/original_safe/sha256-${checksum}.webp`;
      const purpose = mediaType === "logo" ? "property.logo" : "property.hero_image";
      await fixture(async () => {
        await admin.query(
          `INSERT INTO platform.media_objects (
             id, bucket, storage_key, storage_kind, visibility, purpose, property_id,
             resource_product, resource_type, resource_id, lifecycle_status, content_type,
             width_px, height_px, size_bytes, checksum_sha256, public_approved
           ) VALUES ($1, 'vayada-media-test', $2, 'vayada_managed', 'public', $5, $3::uuid,
             'hotel_catalog', 'property', $3::text, 'active', 'image/webp', 1200, 800, 900, $4, TRUE)`,
          [mediaId, `public/${path}`, propertyId, checksum, purpose],
        );
        await admin.query(
          `INSERT INTO platform.media_variants (
             media_object_id, variant_name, visibility, storage_key, content_type,
             width_px, height_px, size_bytes, checksum_sha256, public_cdn_url
           ) VALUES ($1, 'original_safe', 'public', $2, 'image/webp', 1200, 800, 900, $3, $4)`,
          [mediaId, `public/${path}`, checksum, `https://cdn.example.test/${path}`],
        );
        await admin.query(
          `INSERT INTO hotel_catalog.property_media
             (property_id, media_type, url, sort_order, source_system, public_approved,
              platform_media_object_id)
           VALUES ($1, $4, $2, 0, 'platform', TRUE, $3)`,
          [propertyId, `https://cdn.example.test/${path}`, mediaId, mediaType],
        );
      });
    }
    const close = async () => {
      await pool.end();
      await login.drop().catch(() => undefined);
      await admin.end();
    };
    return { admin, repository, owner, manager, hotel, actor, fixture, publicImage, close };
  }

  it("reads a hotel that has only its basics: setup's defaults in use, nothing else yet", async () => {
    const t = await setUp();
    try {
      const propertyId = await t.hotel();
      expect(await t.repository.facts.read(t.actor(propertyId))).toEqual({
        hotelBasics: true,
        bookingPublished: false,
        photos: false,
        style: false,
        calendar: "default",
        guestTerms: "default",
        onlineCardReady: false,
        viewer: { hidden: false, dismissed: false },
      });
      expect(await t.repository.facts.read(t.actor(randomUUID()))).toBeNull();
    } finally {
      await t.close();
    }
  });

  it("keeps Looks good per hotel, and a later one updates who and when", async () => {
    const t = await setUp();
    try {
      const propertyId = await t.hotel();
      await t.repository.store.acknowledge(t.actor(propertyId), "calendar");
      await t.repository.store.acknowledge(t.actor(propertyId, t.manager), "calendar");
      await t.repository.store.acknowledge(t.actor(propertyId), "guest_terms");
      expect(await t.repository.facts.read(t.actor(propertyId, t.manager))).toMatchObject({
        calendar: "acknowledged",
        guestTerms: "acknowledged",
      });
      expect(
        (
          await t.admin.query(
            `SELECT item, acknowledged_by_user_id AS "by"
             FROM hotel_catalog.setup_checklist_acknowledgements
             WHERE property_id = $1 ORDER BY item`,
            [propertyId],
          )
        ).rows,
      ).toEqual([
        { item: "calendar", by: t.manager },
        { item: "guest_terms", by: t.owner },
      ]);
    } finally {
      await t.close();
    }
  });

  it("keeps Hide for now and Dismiss for each person, changing only what is sent", async () => {
    const t = await setUp();
    try {
      const propertyId = await t.hotel();
      await t.repository.store.setViewer(t.actor(propertyId), { hidden: true });
      await t.repository.store.setViewer(t.actor(propertyId), { dismissed: true });
      expect((await t.repository.facts.read(t.actor(propertyId)))?.viewer).toEqual({
        hidden: true,
        dismissed: true,
      });
      await t.repository.store.setViewer(t.actor(propertyId), { hidden: false });
      expect((await t.repository.facts.read(t.actor(propertyId)))?.viewer).toEqual({
        hidden: false,
        dismissed: true,
      });
      // Another person on the same hotel still sees the checklist.
      expect((await t.repository.facts.read(t.actor(propertyId, t.manager)))?.viewer).toEqual({
        hidden: false,
        dismissed: false,
      });
    } finally {
      await t.close();
    }
  });

  it("sees photos, a logo, other terms, a saved auto-open and a published page", async () => {
    const t = await setUp();
    try {
      const propertyId = await t.hotel();
      // The first run's terms are setup's default; other text is the hotel's own.
      await t.admin.query(
        `INSERT INTO hotel_catalog.property_policy_summaries (property_id, terms_and_conditions)
         VALUES ($1, $2)`,
        [propertyId, ` ${FIRST_RUN_GUEST_TERMS} `],
      );
      expect((await t.repository.facts.read(t.actor(propertyId)))?.guestTerms).toBe("default");
      await t.admin.query(
        "UPDATE hotel_catalog.property_policy_summaries SET terms_and_conditions = $2 WHERE property_id = $1",
        [propertyId, "Our own house rules."],
      );
      await t.admin.query(
        `INSERT INTO pms.calendar_auto_open_settings (property_id, revision, enabled, mode, rolling_months)
         VALUES ($1, 1, TRUE, 'rolling', 18)`,
        [propertyId],
      );
      await t.publicImage(propertyId, "hero_image");
      await t.publicImage(propertyId, "logo");
      await t.fixture(() =>
        t.admin.query(
          `INSERT INTO distribution.active_public_booking_revision
             (property_id, content_revision_id, activated_by_user_id)
           VALUES ($1, $2, $3)`,
          [propertyId, randomUUID(), t.owner],
        ),
      );
      expect(await t.repository.facts.read(t.actor(propertyId))).toMatchObject({
        bookingPublished: true,
        photos: true,
        style: true,
        calendar: "changed",
        guestTerms: "changed",
      });
    } finally {
      await t.close();
    }
  });

  it("VAY-2451: the go-live facts count a room's rooms, guests and approved photos only", async () => {
    const t = await setUp();
    try {
      const propertyId = await t.hotel();
      const roomTypeId = randomUUID();
      const photo = async (approved: boolean, sortOrder: number) => {
        const mediaId = randomUUID();
        const checksum = createHash("sha256").update(mediaId).digest("hex");
        await t.admin.query(
          `INSERT INTO platform.media_objects (
             id, bucket, storage_key, storage_kind, visibility, purpose, property_id,
             resource_product, resource_type, resource_id, lifecycle_status, content_type,
             width_px, height_px, size_bytes, checksum_sha256, public_approved
           ) VALUES ($1, 'vayada-media-test', $2, 'vayada_managed', $7, 'pms.room_type.media',
             $3::uuid, 'pms', 'room_type', $4::text, 'active', 'image/webp', 1200, 800, 900, $5, $6)`,
          // Waiting for review means private: only approved media is public.
          [
            mediaId,
            `${approved ? "public" : "private"}/media/${mediaId}.webp`,
            propertyId,
            roomTypeId,
            checksum,
            approved,
            approved ? "public" : "private",
          ],
        );
        await t.admin.query(
          `INSERT INTO pms.room_type_media (property_id, room_type_id, platform_media_object_id, sort_order)
           VALUES ($1, $2, $3, $4)`,
          [propertyId, roomTypeId, mediaId, sortOrder],
        );
      };
      await t.fixture(async () => {
        // A room type from before room facts: its guest limit is stored as maxOccupancy.
        await t.admin.query(
          `INSERT INTO pms.room_types
             (id, property_id, name, base_rate_amount, currency, occupancy_limits, active)
           VALUES ($1, $2, 'Pool Villa', NULL, NULL, '{"maxOccupancy": 4}', TRUE),
                  ($3, $2, 'Old Room', NULL, NULL, '{"total": 2}', FALSE)`,
          [roomTypeId, propertyId, randomUUID()],
        );
        await t.admin.query(
          `INSERT INTO pms.rooms (property_id, room_type_id, room_number, status)
           VALUES ($1, $2, 'Villa 1', 'available'), ($1, $2, 'Villa 2', 'maintenance'),
                  ($1, $2, 'Villa 3', 'retired')`,
          [propertyId, roomTypeId],
        );
        await photo(true, 0);
        // Waiting for review: the page wouldn't show it, so it doesn't count.
        await photo(false, 1);
      });
      expect(await t.repository.goLiveFacts.read(t.actor(propertyId))).toEqual({
        propertyDetails: true,
        bookingPublished: false,
        propertyPhotos: false,
        bookingRules: "default",
        onlineCardReady: false,
        roomTypes: [{ name: "Pool Villa", rooms: 2, maxGuests: 4, photos: 1, priced: false }],
        placeholderPrices: false,
        viewer: { hidden: false, dismissed: false },
      });
      expect(await t.repository.goLiveFacts.read(t.actor(randomUUID()))).toBeNull();
    } finally {
      await t.close();
    }
  });

  it("VAY-2442: online card payments are done once the hotel's own steps are, with no Vayada approval", async () => {
    const t = await setUp();
    try {
      /** A hotel with payments on and card chosen, on a provider account it saved. */
      async function cardHotel(
        provider: "stripe" | "vayada",
        change: { payoutsEnabled?: boolean; cardChosen?: boolean; ready?: boolean } = {},
      ) {
        const propertyId = await t.hotel();
        const accountId = randomUUID();
        const stripe = provider === "stripe";
        await t.fixture(async () => {
          await t.admin.query(
            `INSERT INTO finance.payment_provider_accounts (id, property_id, account_scope, provider,
               provider_account_id, status, onboarding_status, charges_enabled, payouts_enabled,
               capabilities, card_capability_revision, account_metadata)
             VALUES ($1, $2, 'property', $3, $4, 'active', 'completed', TRUE, $5,
               ARRAY['card_payments'], 1, $6::jsonb)`,
            [
              accountId,
              propertyId,
              provider,
              stripe ? `acct_synthetic_${accountId}` : `vayada:${propertyId}`,
              change.payoutsEnabled ?? true,
              JSON.stringify(
                stripe
                  ? {
                      detailsSubmitted: true,
                      cardPaymentsStatus: change.ready === false ? "inactive" : "active",
                    }
                  : { source: "payout_destination" },
              ),
            ],
          );
          await t.admin.query(
            `INSERT INTO finance.payment_settings (property_id, provider_account_id, payments_enabled,
               accepted_methods, default_currency, payment_readiness_contract_version,
               payment_methods_revision, source_pricing_currency_revision)
             VALUES ($1, $2, TRUE, $3, $4, 'finance-payment-readiness.v1', 1, 1)`,
            [
              propertyId,
              accountId,
              change.cardChosen === false ? ["pay_at_property"] : ["card", "pay_at_property"],
              stripe ? "EUR" : "IDR",
            ],
          );
        });
        return propertyId;
      }
      const cards = async (propertyId: string) => ({
        goLive: (await t.repository.goLiveFacts.read(t.actor(propertyId)))?.onlineCardReady,
        checklist: (await t.repository.facts.read(t.actor(propertyId)))?.onlineCardReady,
      });
      const done = { goLive: true, checklist: true };
      const open = { goLive: false, checklist: false };
      // Neither hotel has an approval row: the go-live card's "Online card payments" is done.
      expect(await cards(await cardHotel("stripe"))).toEqual(done);
      expect(await cards(await cardHotel("vayada"))).toEqual(done);
      // Still open while one of the hotel's own steps is missing.
      expect(await cards(await cardHotel("stripe", { ready: false }))).toEqual(open);
      expect(await cards(await cardHotel("vayada", { payoutsEnabled: false }))).toEqual(open);
      expect(await cards(await cardHotel("vayada", { cardChosen: false }))).toEqual(open);
    } finally {
      await t.close();
    }
  });

  it("counts only a logo as style, not a hotel photo", async () => {
    const t = await setUp();
    try {
      const withPhoto = await t.hotel();
      await t.publicImage(withPhoto, "hero_image");
      expect(await t.repository.facts.read(t.actor(withPhoto))).toMatchObject({
        photos: true,
        style: false,
      });
      const withLogo = await t.hotel();
      await t.publicImage(withLogo, "logo");
      expect(await t.repository.facts.read(t.actor(withLogo))).toMatchObject({
        photos: false,
        style: true,
      });
    } finally {
      await t.close();
    }
  });
});
