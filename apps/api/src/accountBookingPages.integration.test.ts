import { randomUUID } from "node:crypto";

import {
  defaultAccountBookingPageSettings,
  type AccountBookingPageSettings,
  type AccountBookingPageUpdate,
} from "@vayada/domain-booking";
import { buildBookingPublicContent } from "@vayada/domain-distribution/booking-publication";
import { PUBLIC_BOOKABILITY_FIXTURES } from "@vayada/domain-distribution/fixtures";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPgAccountBookingPagesRepository,
  readLiveAccountBookingPageStays,
  readPublicAccountBookingPage,
  type AccountBookingPagesRepository,
} from "./domains/accountBookingPages.js";
import { configureActiveBookingPublicationGate } from "./domains/activeBookingPublicationGate.js";
import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "./hotelSetupOrdinaryLogin.fixture.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PUBLIC_ID_PREFIX = "vay-2456-repo-";
const audit = { requestId: "request-1", correlationId: null };

type Stay = {
  name: string;
  type?: string | null;
  located?: boolean;
  /** A visible booking page, one the public site hides (stale), or none. */
  published?: "visible" | "hidden" | null;
};

// VAY-2456: Booking Admin reads and saves the agency booking page as `vayada_next_api_runtime`, so the
// repository runs through the test login that mirrors that role's product-DML posture.
describe.skipIf(!TEST_DATABASE_URL)("Agency booking page repository (runtime login)", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const actorUserId = randomUUID();
  const organizations: string[] = [];
  let fixture: HotelSetupOrdinaryLoginFixture;
  let repository: AccountBookingPagesRepository;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    // As in production: the public site serves setup publications.
    configureActiveBookingPublicationGate({ servesPublications: true, manualPayments: false });
    await admin.query(
      "INSERT INTO identity.users (id, email, name, status) VALUES ($1::uuid, $2, 'VAY-2456', 'active')",
      [actorUserId, `vay-2456-${actorUserId}@example.test`],
    );
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, TEST_DATABASE_URL!);
    repository = createPgAccountBookingPagesRepository({
      connectionString: fixture.connectionString,
    });
  });

  afterAll(async () => {
    configureActiveBookingPublicationGate({ servesPublications: false, manualPayments: false });
    try {
      await repository?.close?.();
      if (fixture) await fixture.drop();
      if (TEST_DATABASE_URL) {
        assertSafeTestDatabase(TEST_DATABASE_URL);
        await cleanup();
      }
    } finally {
      await admin.end();
    }
  });

  it("starts from the defaults with every ready stay included and says what the others miss", async () => {
    const { organizationId, stays } = await travelUbud();
    // Two rooms in the PMS count as units; a retired one doesn't.
    const roomType = randomUUID();
    await admin.query(
      "INSERT INTO pms.room_types (id, property_id, name, active) VALUES ($1, $2, 'Villa', true)",
      [roomType, stays.escape],
    );
    for (const status of ["available", "maintenance", "retired"])
      await admin.query(
        `INSERT INTO pms.rooms (id, property_id, room_type_id, operational_label_status, status)
         VALUES ($1, $2, $3, 'unverified', $4)`,
        [randomUUID(), stays.escape, roomType, status],
      );
    const summary = await repository.read(organizationId);
    expect(summary).toMatchObject({
      saved: false,
      canSave: true,
      page: {
        slug: "the-travel-ubud",
        live: false,
        revision: 0,
        settings: defaultAccountBookingPageSettings("The Travel Ubud"),
        propertyIds: [stays.escape, stays.mandala],
      },
    });
    expect(summary!.properties).toEqual([
      row(stays.astavaka, "Astavaka Villa", "villa", false, ["setup"], false, null),
      { ...row(stays.escape, "Escape Villa", "villa", true, [], true), units: 2 },
      row(stays.mandala, "Mandala Resort", "resort", true, [], true),
      row(stays.perum, "Perum Bali", null, false, ["type", "location"]),
      row(stays.mansion, "The Mansion", "hotel", false, ["location"]),
      row(
        stays.uma,
        "Uma Nature Villa",
        "villa",
        false,
        ["setup"],
        false,
        "https://cdn.example/uma-hero.jpg",
      ),
    ]);
    expect(await repository.read(randomUUID())).toBeNull();
  });

  it("saves every field with the stays in order, writes an audit row, and bumps the revision", async () => {
    const { organizationId, stays } = await travelUbud();
    const settings = customSettings(stays.mandala);
    const first = await repository.save(
      command(organizationId, {
        revision: 0,
        slug: "thetravelubud-1",
        live: true,
        settings,
        propertyIds: [stays.mandala, stays.escape],
      }),
    );
    expect(first).toMatchObject({
      ok: true,
      summary: {
        saved: true,
        page: {
          slug: "thetravelubud-1",
          live: true,
          revision: 1,
          settings,
          propertyIds: [stays.mandala, stays.escape],
        },
      },
    });
    const audits = await admin.query(
      `SELECT action, tenant_scope, actor_user_id::text AS actor, target_resource_type,
              redacted_payload -> 'propertyIds' AS "propertyIds"
       FROM platform.product_audit_events WHERE organization_id = $1::uuid`,
      [organizationId],
    );
    expect(audits.rows).toEqual([
      {
        action: "booking.account_booking_page.updated",
        tenant_scope: "organization",
        actor: actorUserId,
        target_resource_type: "account_booking_page",
        propertyIds: [stays.mandala, stays.escape],
      },
    ]);

    // An edit made on an older revision, or a second "first" save, is refused.
    for (const revision of [0, 2])
      expect(await repository.save(command(organizationId, update(stays, { revision })))).toEqual({
        ok: false,
        error: "page_changed",
      });
    const second = await repository.save(
      command(organizationId, update(stays, { revision: 1, propertyIds: [stays.escape] })),
    );
    expect(second).toMatchObject({
      ok: true,
      summary: { page: { revision: 2, live: false, propertyIds: [stays.escape] } },
    });
  });

  it("refuses foreign or unready stays, a live page with nothing ready, and small accounts", async () => {
    const { organizationId, stays } = await travelUbud();
    const other = await account("Other Agency", [{ name: "Foreign Villa", published: "visible" }]);
    const refuse = async (changes: Partial<AccountBookingPageUpdate>, error: string) =>
      expect(await repository.save(command(organizationId, update(stays, changes)))).toEqual({
        ok: false,
        error,
      });
    await refuse({ propertyIds: [stays.escape, other.stays.foreign] }, "property_not_in_account");
    // The design is copied from an included stay: not another account's, nor one left off the page.
    await refuse({ settings: customSettings(other.stays.foreign) }, "design_property_not_included");
    await refuse({ settings: customSettings(stays.mandala) }, "design_property_not_included");
    for (const unready of [stays.astavaka, stays.perum, stays.mansion, stays.uma])
      await refuse({ propertyIds: [stays.escape, unready] }, "property_not_ready");
    await refuse({ live: true, propertyIds: [] }, "no_ready_property");

    const small = await account("Single Villa Co", [{ name: "Only Villa", published: "visible" }]);
    expect(await repository.read(small.organizationId)).toMatchObject({ canSave: false });
    expect(
      await repository.save(
        command(small.organizationId, update(small.stays, { propertyIds: [] })),
      ),
    ).toEqual({ ok: false, error: "account_needs_two_properties" });
    expect(
      await repository.save(command(randomUUID(), update(stays, { propertyIds: [] }))),
    ).toEqual({ ok: false, error: "account_not_found" });
    expect(
      await admin.query("SELECT 1 FROM booking.account_booking_pages WHERE organization_id = $1", [
        organizationId,
      ]),
    ).toMatchObject({ rows: [] });
  });

  it("refuses an address a hotel or another agency already has", async () => {
    const { organizationId, stays } = await travelUbud();
    const second = await travelUbud();
    expect(
      await repository.save(command(organizationId, update(stays, { slug: stays.hotelSlug }))),
    ).toEqual({ ok: false, error: "slug_taken" });
    const slug = `ubud-${organizationId.slice(0, 8)}`;
    expect(await repository.save(command(organizationId, update(stays, { slug })))).toMatchObject({
      ok: true,
    });
    expect(
      await repository.save(command(second.organizationId, update(second.stays, { slug }))),
    ).toEqual({ ok: false, error: "slug_taken" });
  });

  it("keeps an included stay that stops being ready, and drops one that leaves the account", async () => {
    const { organizationId, stays } = await travelUbud();
    expect(
      await repository.save(
        command(organizationId, update(stays, { propertyIds: [stays.escape, stays.mandala] })),
      ),
    ).toMatchObject({ ok: true });
    await admin.query(
      "UPDATE hotel_catalog.property_locations SET latitude = NULL, longitude = NULL WHERE property_id = $1::uuid",
      [stays.escape],
    );
    const resaved = await repository.save(
      command(
        organizationId,
        update(stays, { revision: 1, propertyIds: [stays.escape, stays.mandala] }),
      ),
    );
    expect(resaved).toMatchObject({ ok: true, summary: { page: { revision: 2 } } });
    if (!resaved.ok) throw new Error("expected a save");
    expect(resaved.summary.properties.find((p) => p.propertyId === stays.escape)).toMatchObject({
      ready: false,
      missing: ["location"],
      included: true,
    });

    await admin.query(
      `UPDATE identity.organization_resource_links SET status = 'archived'
       WHERE organization_id = $1::uuid AND resource_id = $2`,
      [organizationId, stays.mandala],
    );
    const read = await repository.read(organizationId);
    expect(read!.page.propertyIds).toEqual([stays.escape]);
    expect(read!.properties.map((p) => p.propertyId)).not.toContain(stays.mandala);
  });

  it("lets a live page be switched off after the account drops below two active stays", async () => {
    const { organizationId, stays } = await travelUbud();
    expect(
      await repository.save(
        command(organizationId, update(stays, { live: true, propertyIds: [stays.escape] })),
      ),
    ).toMatchObject({ ok: true });
    await admin.query(
      `UPDATE hotel_catalog.properties SET lifecycle_status = 'provisioning'
       WHERE id = ANY($1::uuid[])`,
      [[stays.mandala, stays.mansion, stays.perum, stays.astavaka, stays.uma]],
    );
    expect(await repository.read(organizationId)).toMatchObject({ canSave: false });
    expect(
      await repository.save(
        command(
          organizationId,
          update(stays, { revision: 1, live: true, propertyIds: [stays.escape] }),
        ),
      ),
    ).toEqual({ ok: false, error: "account_needs_two_properties" });
    expect(
      await repository.save(
        command(
          organizationId,
          update(stays, { revision: 1, live: false, propertyIds: [stays.escape] }),
        ),
      ),
    ).toMatchObject({ ok: true, summary: { page: { live: false, revision: 2 } } });
  });

  it("keeps the account's own header image, and refuses another account's or another kind", async () => {
    const { organizationId, stays } = await travelUbud();
    const other = await account("Other Agency", [{ name: "Foreign Villa", published: "visible" }]);
    const own = await headerImage(organizationId, "https://cdn.example/agency-hero-large.jpg");
    const foreign = await headerImage(other.organizationId, "https://cdn.example/foreign.jpg");
    const logo = await headerImage(
      organizationId,
      "https://cdn.example/logo.png",
      "booking.header_logo",
    );
    for (const headerImageMediaId of [foreign, logo, randomUUID()])
      expect(
        await repository.save(command(organizationId, update(stays, { headerImageMediaId }))),
      ).toEqual({ ok: false, error: "header_image_invalid" });

    const saved = await repository.save(
      command(organizationId, update(stays, { headerImageMediaId: own })),
    );
    expect(saved).toMatchObject({
      ok: true,
      summary: {
        page: { headerImage: { mediaId: own, url: "https://cdn.example/agency-hero-large.jpg" } },
      },
    });
    // Left out, the image stays (an older Booking Admin); null removes it.
    expect(
      await repository.save(command(organizationId, update(stays, { revision: 1 }))),
    ).toMatchObject({ ok: true, summary: { page: { headerImage: { mediaId: own } } } });
    expect(
      await repository.save(
        command(organizationId, update(stays, { revision: 2, headerImageMediaId: null })),
      ),
    ).toMatchObject({ ok: true, summary: { page: { headerImage: null } } });
    // Deleting the media clears the page's reference.
    await repository.save(
      command(organizationId, update(stays, { revision: 3, headerImageMediaId: own })),
    );
    await admin.query("DELETE FROM platform.media_objects WHERE id = $1::uuid", [own]);
    expect(await repository.read(organizationId)).toMatchObject({ page: { headerImage: null } });
    expect(
      (
        await admin.query(
          "SELECT header_image_media_object_id FROM booking.account_booking_pages WHERE organization_id = $1",
          [organizationId],
        )
      ).rows,
    ).toEqual([{ header_image_media_object_id: null }]);
  });

  // Public pricing locks the account row FOR UPDATE in short transactions. Reading never waits for it;
  // a save only waits at its audit row (a key-share lock on the account), then finishes.
  it("reads while public pricing holds the account row, and saves once it lets go", async () => {
    const { organizationId, stays } = await travelUbud();
    expect(await repository.save(command(organizationId, update(stays)))).toMatchObject({
      ok: true,
    });
    const pricing = await admin.connect();
    try {
      await pricing.query("BEGIN");
      await pricing.query("SELECT 1 FROM identity.organizations WHERE id = $1::uuid FOR UPDATE", [
        organizationId,
      ]);
      expect(await repository.read(organizationId)).toMatchObject({ saved: true });
      let settled = false;
      const saving = repository
        .save(command(organizationId, update(stays, { revision: 1 })))
        .finally(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await pricing.query("ROLLBACK");
      expect(await saving).toMatchObject({ ok: true, summary: { page: { revision: 2 } } });
    } finally {
      await pricing.query("ROLLBACK").catch(() => undefined);
      pricing.release();
    }
  });

  it("shows guests a live page with its stays' cards, and nothing while it is off (VAY-2459)", async () => {
    const { organizationId, stays } = await travelUbud();
    // Public pricing needs the account to own each stay's PMS property too.
    for (const stay of [stays.escape, stays.mandala, stays.mansion])
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1::uuid, 'pms', 'pms_property', $2, 'owner', 'active')`,
        [organizationId, stay],
      );
    const settings = customSettings(stays.escape!);
    const slug = `agency-${randomUUID().slice(0, 8)}`;
    const image = await headerImage(organizationId, "https://cdn.example/agency-hero-large.jpg");
    expect(
      await repository.save(
        command(
          organizationId,
          update(stays, {
            slug,
            live: true,
            settings,
            propertyIds: [stays.mandala!, stays.escape!],
            headerImageMediaId: image,
          }),
        ),
      ),
    ).toMatchObject({ ok: true });
    // Included but no longer ready (no location), as when a stay stops being ready after a save:
    // guests don't see it.
    await admin.query(
      `INSERT INTO booking.account_booking_page_properties (organization_id, property_id, position)
       VALUES ($1::uuid, $2::uuid, 99)`,
      [organizationId, stays.mansion],
    );
    // Read as the API reads it: the runtime login.
    const runtime = new pg.Pool({ connectionString: fixture.connectionString, max: 1 });
    try {
      const page = await readPublicAccountBookingPage(runtime, slug);
      expect(page).toMatchObject({
        version: "agency-page.v1",
        slug,
        name: "The Travel Ubud",
        page: { title: "The Travel Ubud", description: "13 villas, guest houses and resorts" },
        header: {
          topLeft: "name",
          gallery: true,
          language: true,
          currency: true,
          contact: { email: null, whatsapp: "+6281234567890" },
          imageUrl: "https://cdn.example/agency-hero-large.jpg",
        },
        layout: settings.layout,
        results: settings.results,
        filters: settings.filters,
      });
      expect(page!.stays.map((stay) => [stay.propertyId, stay.name, stay.propertyType])).toEqual([
        [stays.mandala, "Mandala Resort", "resort"],
        [stays.escape, "Escape Villa", "villa"],
      ]);
      expect(page!.stays[0]).toMatchObject({
        slug: `${PUBLIC_ID_PREFIX}${stays.mandala}`,
        currency: "EUR",
        photos: [
          expect.objectContaining({ url: "https://cdn.vayada.example/hotels/alpenrose/front.jpg" }),
        ],
        // Locality and pin private (the location's defaults), no Room Filters (VAY-2460).
        area: null,
        map: null,
        privatePool: false,
        childrenEnabled: expect.any(Boolean),
      });
      expect(page!.locales).toEqual({ default: "en", supported: ["en", "de"] });
      // The design stay's address and currencies, for the currency switch.
      expect(page!.design).toMatchObject({
        slug: `${PUBLIC_ID_PREFIX}${stays.escape}`,
        currency: "EUR",
        displayCurrencies: expect.any(Array),
      });
      // Nothing Booking Admin-only.
      expect(JSON.stringify(page)).not.toMatch(/designPropertyId|contactEmail|organizationId/);

      // Contact off: no contact details; no own image: the design stay's header (or its photo).
      await admin.query(
        `UPDATE booking.account_booking_pages
         SET settings = jsonb_set(settings, '{header,contact}', 'false'),
             header_image_media_object_id = NULL
         WHERE organization_id = $1::uuid`,
        [organizationId],
      );
      const plain = await readPublicAccountBookingPage(runtime, slug);
      expect(plain?.header.contact).toBeNull();
      expect(plain?.header.imageUrl).toMatch(/^https:\/\//);

      // Off, or not an address: nothing.
      await admin.query(
        "UPDATE booking.account_booking_pages SET live = false WHERE organization_id = $1::uuid",
        [organizationId],
      );
      expect(await readPublicAccountBookingPage(runtime, slug)).toBeNull();
      expect(await readPublicAccountBookingPage(runtime, "Not A Page")).toBeNull();
    } finally {
      await runtime.end();
    }
  });

  it("gives each stay its area, map pin and private pool as the stay shows guests, read live (VAY-2460)", async () => {
    const { organizationId, stays } = await travelUbud();
    for (const stay of [stays.escape, stays.mandala])
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1::uuid, 'pms', 'pms_property', $2, 'owner', 'active')`,
        [organizationId, stay],
      );
    const slug = `agency-${randomUUID().slice(0, 8)}`;
    expect(
      await repository.save(
        command(
          organizationId,
          update(stays, { slug, live: true, propertyIds: [stays.escape!, stays.mandala!] }),
        ),
      ),
    ).toMatchObject({ ok: true });
    // Escape shows its locality and exact pin; Mandala hides its locality and shows an area.
    await admin.query(
      `UPDATE hotel_catalog.property_locations
       SET address_public = TRUE, geo_public = TRUE, map_display_mode = 'exact',
           latitude = -8.506512, longitude = 115.262481
       WHERE property_id = $1::uuid`,
      [stays.escape],
    );
    await admin.query(
      `UPDATE hotel_catalog.property_locations
       SET geo_public = TRUE, map_display_mode = 'approximate',
           latitude = -8.51234, longitude = 115.26789
       WHERE property_id = $1::uuid`,
      [stays.mandala],
    );
    // Room Filters: Escape marks a room in use "Private pool"; Mandala only a retired one and a
    // room of a room type it stopped selling.
    const room = async (propertyId: string, status: string, active = true) => {
      const roomType = randomUUID(),
        roomId = randomUUID();
      await admin.query(
        "INSERT INTO pms.room_types (id, property_id, name, active) VALUES ($1, $2, 'Villa', $3)",
        [roomType, propertyId, active],
      );
      await admin.query(
        `INSERT INTO pms.rooms (id, property_id, room_type_id, operational_label_status, status)
         VALUES ($1, $2, $3, 'unverified', $4)`,
        [roomId, propertyId, roomType, status],
      );
      return roomId;
    };
    const filters = async (propertyId: string, rooms: string[], on = true) =>
      admin.query(
        `INSERT INTO booking.booking_settings (property_id, booking_filters, filter_rooms)
         VALUES ($1::uuid, $2::jsonb, $3::jsonb)
         ON CONFLICT (property_id) DO UPDATE
           SET booking_filters = EXCLUDED.booking_filters, filter_rooms = EXCLUDED.filter_rooms`,
        [
          propertyId,
          JSON.stringify(on ? ["privatePool"] : []),
          JSON.stringify(on ? { privatePool: rooms } : {}),
        ],
      );
    const pool = await room(stays.escape!, "available");
    await filters(stays.escape!, [randomUUID(), pool]);
    await filters(stays.mandala!, [
      await room(stays.mandala!, "retired"),
      await room(stays.mandala!, "available", false),
    ]);

    const runtime = new pg.Pool({ connectionString: fixture.connectionString, max: 1 });
    try {
      const facts = async () =>
        (await readPublicAccountBookingPage(runtime, slug))!.stays.map((stay) => ({
          propertyId: stay.propertyId,
          area: stay.area,
          map: stay.map,
          privatePool: stay.privatePool,
        }));
      // VAY-2461: each stay's rooms in use, for "2 villas" on its stay page. Escape has one room
      // in use; Mandala's are retired or of a room type it stopped selling (which still count).
      expect(
        (await readPublicAccountBookingPage(runtime, slug))!.stays.map((stay) => stay.units),
      ).toEqual([1, 1]);
      expect(await facts()).toEqual([
        {
          propertyId: stays.escape,
          area: "Ubud",
          map: { latitude: -8.506512, longitude: 115.262481, approximate: false },
          privatePool: true,
        },
        {
          propertyId: stays.mandala,
          area: null,
          // Rounded to about a kilometre, as the stay's own page shows it.
          map: { latitude: -8.51, longitude: 115.27, approximate: true },
          privatePool: false,
        },
      ]);
      // The price read learns each stay's time zone, for free cancellation deadlines.
      expect((await readLiveAccountBookingPageStays(runtime, slug))?.stays).toEqual([
        expect.objectContaining({ propertyId: stays.escape, timezone: "Asia/Makassar" }),
        expect.objectContaining({ propertyId: stays.mandala, timezone: "Asia/Makassar" }),
      ]);

      // Hidden on the map, or the Private pool filter switched off: at once. (The guest route
      // keeps each page 30 s.)
      await admin.query(
        "UPDATE hotel_catalog.property_locations SET map_display_mode = 'hidden' WHERE property_id = $1::uuid",
        [stays.escape],
      );
      await filters(stays.escape!, [pool], false);
      expect((await facts())[0]).toEqual({
        propertyId: stays.escape,
        area: "Ubud",
        map: null,
        privatePool: false,
      });
      // Exact, but the location itself private: no pin either.
      await admin.query(
        `UPDATE hotel_catalog.property_locations
         SET map_display_mode = 'exact', geo_public = FALSE WHERE property_id = $1::uuid`,
        [stays.escape],
      );
      expect((await facts())[0]!.map).toBeNull();
    } finally {
      await runtime.end();
    }
  });

  function command(organizationId: string, value: AccountBookingPageUpdate) {
    return { organizationId, update: value, audit: { actorUserId, ...audit } };
  }

  function update(
    stays: Record<string, string>,
    changes: Partial<AccountBookingPageUpdate> = {},
  ): AccountBookingPageUpdate {
    return {
      revision: 0,
      slug: `agency-${randomUUID().slice(0, 8)}`,
      live: false,
      settings: defaultAccountBookingPageSettings("The Travel Ubud"),
      propertyIds: [stays["escape"]!],
      ...changes,
    };
  }

  async function travelUbud() {
    return account("The Travel Ubud", [
      { name: "Escape Villa", type: "villa", published: "visible" },
      { name: "Mandala Resort", type: "resort", published: "visible" },
      { name: "The Mansion", type: "hotel", located: false, published: "visible" },
      { name: "Perum Bali", type: null, located: false, published: "visible" },
      { name: "Astavaka Villa", type: "villa", published: null },
      { name: "Uma Nature Villa", type: "villa", published: "hidden" },
    ]);
  }

  async function account(name: string, list: Stay[]) {
    const organizationId = randomUUID();
    organizations.push(organizationId);
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', $2, $3, 'active')`,
      [organizationId, name, `vay-2456-${organizationId}`],
    );
    const stays: Record<string, string> = {};
    for (const stay of list) {
      const propertyId = randomUUID();
      const key = stay.name
        .split(" ")
        .find((word) => word !== "The")!
        .toLowerCase();
      stays[key] = propertyId;
      const slug = `${PUBLIC_ID_PREFIX}${propertyId}`;
      await admin.query(
        `INSERT INTO hotel_catalog.properties
           (id, public_id, display_name, property_type, lifecycle_status)
         VALUES ($1::uuid, $2, $3, $4, 'active')`,
        [propertyId, slug, stay.name, stay.type === undefined ? "villa" : stay.type],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.property_locations (property_id, timezone, latitude, longitude, area)
         VALUES ($1::uuid, 'Asia/Makassar', $2, $3, 'Ubud')`,
        [propertyId, stay.located === false ? null : -8.5, stay.located === false ? null : 115.26],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status)
         VALUES ($1::uuid, $2, 'canonical', 'active')`,
        [propertyId, slug],
      );
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1::uuid, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
        [organizationId, propertyId],
      );
      if (stay.published) await publish(propertyId, slug, stay.published);
      stays["hotelSlug"] = slug;
    }
    return { organizationId, stays };
  }

  /** A finished public upload with a large variant, as platform media leaves it (VAY-2457). */
  async function headerImage(
    organizationId: string,
    url: string,
    purpose = "booking.account_page.header_image",
  ): Promise<string> {
    const id = randomUUID();
    const page = purpose === "booking.account_page.header_image";
    await admin.query(
      `INSERT INTO platform.media_objects
         (id, bucket, storage_key, visibility, purpose, owner_organization_id, resource_product,
          resource_type, resource_id, lifecycle_status, public_approved, content_type)
       VALUES ($1::uuid, 'vayada-test', $2, 'public', $3, $4::uuid, 'booking', $5, $6, 'active', TRUE,
         'image/jpeg')`,
      [
        id,
        `media/${id}`,
        purpose,
        organizationId,
        page ? "account_booking_page" : "booking_hotel",
        page ? organizationId : "booking_hotel_alpenrose",
      ],
    );
    await admin.query(
      `INSERT INTO platform.media_variants
         (media_object_id, variant_name, visibility, storage_key, content_type, public_cdn_url)
       VALUES ($1::uuid, 'large', 'public', $2, 'image/jpeg', $3)`,
      [id, `media/${id}/large`, url],
    );
    return id;
  }

  async function publish(propertyId: string, slug: string, state: "visible" | "hidden") {
    const bookable = PUBLIC_BOOKABILITY_FIXTURES.find((item) => item.caseId === "bookable")!;
    const profile = structuredClone(bookable.profile);
    profile.hotel.propertyId = propertyId;
    profile.hotel.slug = slug;
    // Only a fresh, bookable page can be built; a hidden one goes stale after it was published.
    // The build is frozen; mark a copy stale.
    const content = structuredClone(publicContent(profile)) as unknown as {
      profile: { freshness: { status: string }; hotel: Record<string, unknown> };
    };
    if (state === "hidden") {
      content.profile.freshness.status = "stale";
      // Its published hero comes before the room photo in Booking Admin's list.
      content.profile.hotel["branding"] = { heroImage: "https://cdn.example/uma-hero.jpg" };
    }
    const revisionId = randomUUID();
    await admin.query(
      `INSERT INTO distribution.public_booking_content_revisions (
         id, property_id, revision_number, readiness_contract_version, source_manifest,
         source_manifest_hash, readiness_hash, readiness_product, readiness_status, public_content,
         built_by_user_id
       ) VALUES ($1::uuid, $2::uuid, 1, 'onboarding-product-readiness.v1', $3::jsonb, $4, $5,
         'booking', 'ready', $6::jsonb, $7::uuid)`,
      [
        revisionId,
        propertyId,
        JSON.stringify({
          contractVersion: "onboarding-source-manifest.v1",
          propertyId,
          sources: [{ owner: "hotel_catalog", entityId: propertyId, revision: "1" }],
        }),
        `sha256:${"1".repeat(64)}`,
        `sha256:${"2".repeat(64)}`,
        JSON.stringify(content),
        actorUserId,
      ],
    );
    await admin.query(
      `INSERT INTO distribution.active_public_booking_revision
         (property_id, content_revision_id, activated_by_user_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [propertyId, revisionId, actorUserId],
    );
  }

  async function cleanup() {
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      const properties = (
        await client.query<{ id: string }>(
          "SELECT id::text FROM hotel_catalog.properties WHERE public_id LIKE $1",
          [`${PUBLIC_ID_PREFIX}%`],
        )
      ).rows.map(({ id }) => id);
      // Replica mode skips the append-only triggers and FK cascades, so every row goes explicitly.
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `DELETE FROM platform.media_variants WHERE media_object_id IN (
           SELECT id FROM platform.media_objects WHERE owner_organization_id = ANY($1::uuid[]))`,
        [organizations],
      );
      for (const [table, column, ids] of [
        ["platform.product_audit_events", "organization_id", organizations],
        ["booking.account_booking_page_properties", "organization_id", organizations],
        ["booking.account_booking_pages", "organization_id", organizations],
        ["identity.organization_resource_links", "organization_id", organizations],
        ["booking.booking_settings", "property_id", properties],
        ["pms.rooms", "property_id", properties],
        ["pms.room_types", "property_id", properties],
        ["distribution.active_public_booking_revision", "property_id", properties],
        ["distribution.public_booking_content_revisions", "property_id", properties],
        ["hotel_catalog.property_slugs", "property_id", properties],
        ["hotel_catalog.property_locations", "property_id", properties],
        ["hotel_catalog.properties", "id", properties],
        ["platform.media_objects", "owner_organization_id", organizations],
        ["identity.organizations", "id", organizations],
      ] as const)
        await client.query(`DELETE FROM ${table} WHERE ${column} = ANY($1::uuid[])`, [ids]);
      await client.query("DELETE FROM identity.users WHERE id = $1::uuid", [actorUserId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});

function row(
  propertyId: string,
  name: string,
  propertyType: string | null,
  ready: boolean,
  missing: string[],
  included = false,
  // Published stays show their first room photo (none has a hero image); nobody has PMS rooms here.
  photoUrl: string | null = "https://cdn.example/villa.jpg",
) {
  return {
    propertyId,
    name,
    propertyType,
    area: "Ubud",
    photoUrl,
    units: 0,
    ready,
    missing,
    included,
  };
}

function customSettings(designPropertyId: string): AccountBookingPageSettings {
  const settings = defaultAccountBookingPageSettings("The Travel Ubud");
  return {
    ...settings,
    page: { title: "The Travel Ubud", description: "13 villas, guest houses and resorts" },
    header: {
      ...settings.header,
      designPropertyId,
      contact: true,
      contactWhatsapp: "+6281234567890",
    },
    layout: { allowed: ["list", "split"], default: "split" },
    results: { defaultSort: "recommended", lowestPriceBadge: false, showFullStays: false },
  };
}

function publicContent(profile: (typeof PUBLIC_BOOKABILITY_FIXTURES)[number]["profile"]) {
  const result = buildBookingPublicContent({
    sourceManifestHash: `sha256:${"1".repeat(64)}`,
    readinessHash: `sha256:${"2".repeat(64)}`,
    profile,
    rooms: [
      {
        roomTypeId: "room-1",
        name: "Villa",
        description: "A villa.",
        category: null,
        occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
        beds: [{ type: "double", quantity: 1 }],
        bedrooms: 1,
        bathrooms: 1,
        bathroomType: "private",
        size: null,
        images: [{ url: "https://cdn.example/villa.jpg" }],
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

function assertSafeTestDatabase(url: string) {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) throw new Error(`Refusing to run against ${name}`);
}
