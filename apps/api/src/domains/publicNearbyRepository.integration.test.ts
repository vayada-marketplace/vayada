import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPgPublicNearbyRepository } from "./publicNearbyRepository.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("public nearby live PostgreSQL gates", () => {
  const admin = new pg.Client({ connectionString: url });
  const repository = createPgPublicNearbyRepository(url ?? "disabled", admin);
  const propertyId = randomUUID(),
    organizationId = randomUUID(),
    userId = randomUUID(),
    revisionId = randomUUID();
  const custom = {
    id: randomUUID(),
    name: "Our beach",
    address: "Beach road",
    latitude: -1.1,
    longitude: 1.1,
    category: "nature",
    favorite: true,
    hidden: false,
    note: "Our favorite",
  };
  const read = () => repository.read(propertyId);
  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(url!).pathname.slice(1)))
      throw new Error("Test database required");
    await admin.connect();
    await admin.query("BEGIN");
    await admin.query(
      "INSERT INTO identity.users(id,email,name,status) VALUES ($1,$1::uuid::text || '@example.test','Nearby','active')",
      [userId],
    );
    await admin.query(
      "INSERT INTO identity.organizations(id,kind,name,slug) VALUES ($1,'hotel_group','Nearby',$1::uuid::text)",
      [organizationId],
    );
    await admin.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name,lifecycle_status) VALUES ($1,$1::uuid::text,'Nearby','active')",
      [propertyId],
    );
    for (const [product, type] of [
      ["hotel_catalog", "property"],
      ["booking", "booking_hotel"],
    ])
      await admin.query(
        "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES ($1,$2,$3,$4,'owner','active')",
        [organizationId, product, type, propertyId],
      );
    await admin.query(
      "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status) VALUES ($1,'booking','booking-engine','active')",
      [organizationId],
    );
    await admin.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,latitude,longitude,geo_public,map_display_mode) VALUES ($1,-1.125,1.005,true,'approximate')",
      [propertyId],
    );
    await admin.query(
      `INSERT INTO distribution.public_booking_content_revisions
      (id,property_id,revision_number,readiness_contract_version,source_manifest,source_manifest_hash,readiness_hash,readiness_product,readiness_status,public_content,built_by_user_id)
      VALUES ($1,$2,1,'onboarding-product-readiness.v1',$3,$4,$4,'booking','ready','{}',$5)`,
      [
        revisionId,
        propertyId,
        JSON.stringify({
          contractVersion: "onboarding-source-manifest.v1",
          propertyId,
          sources: [{}],
        }),
        `sha256:${"1".repeat(64)}`,
        userId,
      ],
    );
    await admin.query(
      "INSERT INTO distribution.active_public_booking_revision(property_id,content_revision_id,activated_by_user_id) VALUES ($1,$2,$3)",
      [propertyId, revisionId, userId],
    );
    await admin.query(
      "INSERT INTO booking.booking_settings(property_id,nearby_places_enabled) VALUES ($1,true)",
      [propertyId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_nearby_curation(property_id,revision,saved_profile_revision,choices,custom_places)
      VALUES ($1,1,1,$2,$3)`,
      [
        propertyId,
        JSON.stringify([
          {
            placeId: "hidden-beach",
            category: "nature",
            favorite: false,
            hidden: true,
            added: false,
            note: null,
          },
        ]),
        JSON.stringify([custom]),
      ],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_nearby_discovery(property_id,profile_revision,policy_version,status,places,valid_until,retry_after)
      VALUES ($1,1,'nearby-v1','ready',$2,now()+interval '1 hour',now())`,
      [
        propertyId,
        JSON.stringify([
          { placeId: "hidden-beach", category: "nature" },
          { placeId: "cafe", category: "food" },
        ]),
      ],
    );
  });
  beforeEach(() => admin.query("SAVEPOINT nearby_case"));
  afterEach(() => admin.query("ROLLBACK TO SAVEPOINT nearby_case"));
  afterAll(async () => {
    await admin.query("ROLLBACK");
    await admin.end();
  });
  it("projects only public precision and the host's own places", async () => {
    const result = await read();
    expect(result?.public.location).toEqual({
      mode: "approximate",
      latitude: -1.13,
      longitude: 1.01,
    });
    // Guests get only the host's own places in v1 (VAY-2326), not the Google suggestion "cafe".
    expect(result?.public).toMatchObject({
      status: "ready",
      places: [{ source: "custom", name: "Our beach", favorite: true }],
    });
    expect(result?.needsRefresh).toBe(false);
    const payload = JSON.stringify(result?.public);
    for (const forbidden of [
      propertyId,
      organizationId,
      "-1.125",
      "1.005",
      "hidden-beach",
      "cafe",
      "profileRevision",
      "retryAfter",
    ])
      expect(payload).not.toContain(forbidden);
    await admin.query(
      "UPDATE hotel_catalog.property_locations SET map_display_mode='exact' WHERE property_id=$1",
      [propertyId],
    );
    expect((await read())?.public.location?.latitude).toBe(-1.125);
  });
  it.each(["map_display_mode='hidden'", "geo_public=false", "latitude=NULL,longitude=NULL"])(
    "suppresses private destinations for %s",
    async (change) => {
      await admin.query(
        `UPDATE hotel_catalog.property_locations SET ${change} WHERE property_id=$1`,
        [propertyId],
      );
      expect((await read())?.public).toMatchObject({ location: null, places: [] });
      expect((await read())?.needsRefresh).toBe(false);
    },
  );
  it.each([
    "UPDATE identity.product_entitlements SET status='suspended'",
    "UPDATE identity.product_entitlements SET status='expired'",
    "UPDATE identity.product_entitlements SET expires_at=now()-interval '1 day'",
    "DELETE FROM identity.product_entitlements",
    "UPDATE identity.organization_resource_links SET status='suspended'",
    "UPDATE identity.organizations SET status='suspended'",
    "UPDATE hotel_catalog.properties SET lifecycle_status='provisioning'",
    "DELETE FROM distribution.active_public_booking_revision",
  ])("denies revoked publication/access: %s", async (sql) => {
    await admin.query(sql);
    expect(await read()).toBeNull();
  });
  it("never asks for a Google lookup, and pauses the host's places after a move until saved again", async () => {
    await admin.query(
      "UPDATE hotel_catalog.property_nearby_discovery SET valid_until=now()-interval '1 second' WHERE property_id=$1",
      [propertyId],
    );
    expect(await read()).toMatchObject({ needsRefresh: false, public: { status: "ready" } });
    expect((await read())?.public.places).toHaveLength(1);
    await admin.query("UPDATE hotel_catalog.properties SET profile_revision=2 WHERE id=$1", [
      propertyId,
    ]);
    expect(await read()).toMatchObject({
      needsRefresh: false,
      public: { status: "empty", places: [] },
    });
  });
  it.each([
    "UPDATE booking.booking_settings SET nearby_places_enabled=false WHERE property_id=$1",
    "DELETE FROM booking.booking_settings WHERE property_id=$1",
  ])("shows guests no places while Show nearby places is off (VAY-2326): %s", async (sql) => {
    await admin.query(sql, [propertyId]);
    expect(await read()).toMatchObject({
      needsRefresh: false,
      public: { status: "hidden", location: null, places: [], categories: [] },
    });
  });
  it("lists the host's places in the host's order with their categories (VAY-2326)", async () => {
    const music = { id: randomUUID(), name: "Live music", color: "pink", icon: "musical-note" };
    const jazz = {
      ...custom,
      id: randomUUID(),
      name: "Jazz club",
      category: music.id,
      favorite: false,
    };
    await admin.query(
      `UPDATE hotel_catalog.property_nearby_curation
       SET custom_places=$2, custom_categories=$3, category_names='{"food":"Street food"}' WHERE property_id=$1`,
      [propertyId, JSON.stringify([jazz, custom]), JSON.stringify([music])],
    );
    const nearby = (await read())?.public;
    expect(
      nearby?.places.map((place) => (place.source === "custom" ? place.name : place.placeId)),
    ).toEqual(["Jazz club", "Our beach"]);
    expect(nearby?.categories).toEqual([
      { id: "food", name: "Street food", color: "orange", icon: "cake" },
      { id: "nature", name: null, color: "teal", icon: "sun" },
      { id: "activities", name: null, color: "purple", icon: "camera" },
      { id: "transport", name: null, color: "slate", icon: "map" },
      music,
    ]);
  });
});
